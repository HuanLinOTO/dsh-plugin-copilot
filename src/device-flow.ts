/**
 * GitHub OAuth device flow (RFC 8628) for GitHub Copilot, behaviorally
 * identical to opencode's `auth.login.github-copilot` method: request a
 * device code from `{domain}/login/device/code`, show the verification URL
 * and user code, then poll `{domain}/login/oauth/access_token` until the
 * user approves, denies, or the code expires. `slow_down` honors the RFC's
 * +5s and a server-provided interval, always padded with the same 3s clock
 * skew margin opencode adds.
 *
 * `fetch` and `sleep` are injectable so the whole state machine unit-tests
 * offline.
 *
 * @module @huanlin/dsh-plugin-copilot/device-flow
 */

/** Extra polling delay so we never poll slightly before the server expects (opencode parity). */
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000
/** Default polling interval when the device response omits one (RFC suggests 5s). */
export const DEFAULT_DEVICE_INTERVAL_S = 5

/** One pending device-flow session, as the user sees it. */
export interface DeviceFlowStart {
  /** URL the user opens (`https://github.com/login/device` for github.com). */
  verificationUri: string
  /** The short code the user types in. */
  userCode: string
  /** Opaque device code used for polling. */
  deviceCode: string
  /** Server-requested poll interval in milliseconds. */
  intervalMs: number
  /** Seconds until the user code expires, when the server states one. */
  expiresInSeconds?: number
}

/** How one polling session ended. */
export type DeviceFlowOutcome =
  | { kind: 'authorized'; githubToken: string }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string }

/** Injectable transports for offline testing. */
export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch
  /** Resolves after `ms`; rejects when `signal` aborts first. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Thrown when the caller cancels a polling session; tools map it to a cancel value. */
export class DeviceFlowCancelled extends Error {
  constructor() {
    super('copilot device-flow login cancelled')
    this.name = 'DeviceFlowCancelled'
  }
}

export function deviceCodeUrl(domain: string): string {
  return `https://${domain}/login/device/code`
}

export function accessTokenUrl(domain: string): string {
  return `https://${domain}/login/oauth/access_token`
}

/** Default sleep: a timer that rejects with {@link DeviceFlowCancelled} when the signal aborts first. */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeviceFlowCancelled())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DeviceFlowCancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface DeviceCodeResponse {
  verification_uri?: string
  user_code?: string
  device_code?: string
  interval?: number
  expires_in?: number
}

interface AccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
  interval?: number
}

/** JSON POST helper shared by both endpoints; non-2xx fails loud. */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`GitHub OAuth request to ${url} failed with HTTP ${response.status}`)
  }
  return await response.json() as Record<string, unknown>
}

/**
 * Begin a device-flow session on `domain` (github.com or an enterprise
 * host). The caller shows {@link DeviceFlowStart.verificationUri} and
 * {@link DeviceFlowStart.userCode} to the user, then hands the value to
 * {@link pollDeviceFlow}.
 */
export async function startDeviceFlow(
  domain: string,
  clientId: string,
  deps: DeviceFlowDeps = {},
): Promise<DeviceFlowStart> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const data = await postJson(deviceCodeUrl(domain), {
    client_id: clientId,
    scope: 'read:user',
  }, fetchImpl) as DeviceCodeResponse
  if (typeof data.verification_uri !== 'string'
    || typeof data.user_code !== 'string'
    || typeof data.device_code !== 'string') {
    throw new Error('GitHub device authorization response is missing required fields')
  }
  const intervalS = typeof data.interval === 'number' && data.interval > 0 ? data.interval : DEFAULT_DEVICE_INTERVAL_S
  return {
    verificationUri: data.verification_uri,
    userCode: data.user_code,
    deviceCode: data.device_code,
    intervalMs: intervalS * 1_000,
    ...typeof data.expires_in === 'number' ? { expiresInSeconds: data.expires_in } : {},
  }
}

/**
 * Poll until the flow settles. Every wait honors `signal`; aborting throws
 * {@link DeviceFlowCancelled}. Terminal outcomes per RFC 8628 plus GitHub's
 * vocabulary: `access_denied` → denied, `expired_token` → expired, anything
 * else → failed with the server-provided description.
 */
export async function pollDeviceFlow(
  start: DeviceFlowStart,
  domain: string,
  clientId: string,
  signal: AbortSignal,
  deps: DeviceFlowDeps = {},
): Promise<DeviceFlowOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? sleepWithSignal
  let intervalMs = start.intervalMs
  while (true) {
    const data = await postJson(accessTokenUrl(domain), {
      client_id: clientId,
      device_code: start.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, fetchImpl) as AccessTokenResponse

    if (typeof data.access_token === 'string' && data.access_token.length > 0) {
      return { kind: 'authorized', githubToken: data.access_token }
    }
    if (data.error === 'authorization_pending') {
      await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, signal)
      continue
    }
    if (data.error === 'slow_down') {
      // RFC 8628 §3.5: add 5s to the current interval; a server-provided
      // interval (seconds) wins when present (opencode parity).
      intervalMs = typeof data.interval === 'number' && data.interval > 0
        ? data.interval * 1_000
        : intervalMs + 5_000
      await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, signal)
      continue
    }
    if (data.error === 'access_denied') return { kind: 'denied' }
    if (data.error === 'expired_token') return { kind: 'expired' }
    return {
      kind: 'failed',
      message: data.error_description ?? data.error ?? 'GitHub device flow failed without an error code',
    }
  }
}
