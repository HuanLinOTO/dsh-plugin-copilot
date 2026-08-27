/** Device-flow unit tests: the full RFC 8628 state machine, offline. */

import { describe, expect, it } from 'vitest'
import {
  startDeviceFlow,
  pollDeviceFlow,
  DeviceFlowCancelled,
  sleepWithSignal,
  deviceCodeUrl,
  accessTokenUrl,
} from '../src/device-flow.ts'
import type { DeviceFlowDeps } from '../src/device-flow.ts'

const START_RESPONSE = {
  verification_uri: 'https://github.com/login/device',
  user_code: 'ABCD-1234',
  device_code: 'device123',
  interval: 5,
  expires_in: 899,
}

/** A fake fetch answering JSON per URL with a recorded request log. */
function fakeFetch(responses: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { url: string; body: unknown }[] = []
  const impl = (async (url: string | URL | RequestInfo, init?: RequestInit) => {
    const href = url instanceof URL ? url.href : typeof url === 'string' ? url : (url as Request).url
    calls.push({ url: href, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) })
    const entry = responses[href]
    const value = typeof entry === 'function' ? (entry as (body: unknown) => unknown)(calls[calls.length - 1].body) : entry
    return new Response(JSON.stringify(value ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Sleep stub: resolves immediately, records the requested delays, honors aborts. */
function fakeSleep(): (ms: number, signal: AbortSignal) => Promise<void> {
  const delays: number[] = []
  const impl = async (ms: number, signal: AbortSignal) => {
    delays.push(ms)
    if (signal.aborted) throw new DeviceFlowCancelled()
  }
  return Object.assign(impl, { delays })
}

function depsWith(fetchImpl: typeof fetch, sleep: ReturnType<typeof fakeSleep>): DeviceFlowDeps {
  return { fetchImpl, sleep }
}

describe('device flow', () => {
  it('starts a session against the right URLs', async () => {
    const { impl, calls } = fakeFetch({ [deviceCodeUrl('github.com')]: START_RESPONSE })
    const start = await startDeviceFlow('github.com', 'client-1', { fetchImpl: impl })
    expect(start).toMatchObject({
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      deviceCode: 'device123',
      intervalMs: 5_000,
      expiresInSeconds: 899,
    })
    expect(calls[0]?.body).toMatchObject({ client_id: 'client-1', scope: 'read:user' })
  })

  it('defaults the interval when the server omits one', async () => {
    const { impl } = fakeFetch({
      [deviceCodeUrl('github.com')]: { ...START_RESPONSE, interval: undefined },
    })
    const start = await startDeviceFlow('github.com', 'client-1', { fetchImpl: impl })
    expect(start.intervalMs).toBe(5_000)
  })

  it('polls until authorized, honoring pending waits with the safety margin', async () => {
    let n = 0
    const { impl, calls } = fakeFetch({
      [deviceCodeUrl('github.com')]: START_RESPONSE,
      [accessTokenUrl('github.com')]: () => {
        n += 1
        if (n < 3) return { error: 'authorization_pending' }
        return { access_token: 'gho_final' }
      },
    })
    const sleep = fakeSleep()
    const start = await startDeviceFlow('github.com', 'c', { fetchImpl: impl })
    const outcome = await pollDeviceFlow(start, 'github.com', 'c', new AbortController().signal, depsWith(impl, sleep))
    expect(outcome).toEqual({ kind: 'authorized', githubToken: 'gho_final' })
    expect(sleep.delays).toEqual([5_000 + 3_000, 5_000 + 3_000])
    expect(calls.at(-1)?.body).toMatchObject({
      device_code: 'device123',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  })

  it('adds five seconds on slow_down and honors a server-provided interval', async () => {
    const responses = [
      { error: 'slow_down' },
      { error: 'slow_down', interval: 8 },
      { access_token: 'gho_slow' },
    ]
    let n = 0
    const { impl } = fakeFetch({
      [deviceCodeUrl('github.com')]: START_RESPONSE,
      [accessTokenUrl('github.com')]: () => responses[n++] ?? { error: 'authorization_pending' },
    })
    const sleep = fakeSleep()
    const start = await startDeviceFlow('github.com', 'c', { fetchImpl: impl })
    const outcome = await pollDeviceFlow(start, 'github.com', 'c', new AbortController().signal, depsWith(impl, sleep))
    expect(outcome).toEqual({ kind: 'authorized', githubToken: 'gho_slow' })
    expect(sleep.delays).toEqual([10_000 + 3_000, 8_000 + 3_000])
  })

  it('maps denial, expiry, and unknown errors to terminal outcomes', async () => {
    for (const [error, expected] of [
      ['access_denied', { kind: 'denied' }],
      ['expired_token', { kind: 'expired' }],
      ['something_else', { kind: 'failed' }],
    ] as const) {
      const { impl } = fakeFetch({ [deviceCodeUrl('github.com')]: START_RESPONSE, [accessTokenUrl('github.com')]: { error } })
      const start = await startDeviceFlow('github.com', 'c', { fetchImpl: impl })
      const outcome = await pollDeviceFlow(start, 'github.com', 'c', new AbortController().signal, depsWith(impl, fakeSleep()))
      if (expected.kind === 'failed') {
        expect(outcome).toMatchObject({ kind: 'failed', message: 'something_else' })
      } else {
        expect(outcome).toEqual(expected)
      }
    }
  })

  it('surfaces the error description on failure', async () => {
    const { impl } = fakeFetch({
      [deviceCodeUrl('github.com')]: START_RESPONSE,
      [accessTokenUrl('github.com')]: {
        error: 'unsupported_grant_type',
        error_description: 'grant type not supported',
      },
    })
    const start = await startDeviceFlow('github.com', 'c', { fetchImpl: impl })
    const outcome = await pollDeviceFlow(start, 'github.com', 'c', new AbortController().signal, depsWith(impl, fakeSleep()))
    expect(outcome).toEqual({ kind: 'failed', message: 'grant type not supported' })
  })

  it('cancels through the signal while waiting', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleepWithSignal(1_000, controller.signal)).rejects.toBeInstanceOf(DeviceFlowCancelled)
  })
})
