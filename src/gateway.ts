/**
 * Host-side HTTP gateway exposing the Copilot onboarding face to the browser
 * through a self-hosted `/copilot/api` route (same-origin only).
 *
 * Wire shape (POST, JSON envelope `{ ok, value | error }` like the
 * sidebar-brand-text precedent):
 *   status  → { flowAvailable, loggedIn, profileActivated, inFlight, models }
 *   login   → long-polls one device-flow attempt; intermediate notices are
 *             polled via `events` (see below) — the request resolves only when
 *             the attempt settles (authorized / cancelled / error)
 *   cancel  → withdraw the running attempt
 *   events  → { since } → notices emitted after sequence `since`
 *   logout  → delete the Copilot credential record
 *   autofill → idempotently write `llm-pi-ai.providers.github-copilot = {}`
 *
 * `login` cannot ride a single request/response cleanly because the device
 * flow takes minutes, so the gateway keeps a bounded notice ring the client
 * polls; the login request itself resolves at settlement.
 *
 * @module @huanlin/dsh-plugin-copilot/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationEntry, AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CopilotStatus } from './status.ts'
import { COPILOT_PROVIDER, findCopilotFlow, joinStatus, recordAddress } from './status.ts'

/** HTTP route prefix owning every copilot API request. */
const API_PREFIX = '/copilot/api'

/**
 * The pi-ai Copilot flow opens by asking for the enterprise deployment, where
 * blank is the normal answer ("blank for github.com"). Matched by the concept
 * its message names rather than the exact copy, so a wording tweak upstream
 * degrades into the manual prompt path instead of a wrong auto-answer.
 * @param prompt - the prompt the flow raised.
 * @returns whether this is the enterprise-domain question.
 */
function isEnterpriseDomainPrompt(prompt: AuthorizationPrompt): boolean {
  return prompt.kind === 'text' && /enterprise/i.test(prompt.message)
}

/** Upper bound on the buffered notice ring the client replays from. */
const MAX_BUFFERED_NOTICES = 64

/** One notice as the browser consumes it. */
export interface CopilotNoticeEvent {
  /** Monotonic sequence; the client polls with the last one it saw. */
  seq: number
  /** Notice text. */
  message: string
  /** Page the human must open, when the notice carries one. */
  url?: string
  /** Code the human must enter there, when the notice carries one. */
  code?: string
}

/** One queued prompt question the browser must answer. */
export interface CopilotPromptEvent {
  /** Monotonic sequence in the same stream as notices. */
  seq: number
  /** Prompt shape: text / secret / select (see the authorization seam). */
  prompt: AuthorizationPrompt
}

/** Login call status: settlement or in-progress. */
export type LoginOutcome =
  | { status: 'authorized' }
  | { status: 'cancelled' }
  | { status: 'error', message: string }

/** Host capabilities the gateway drives. */
export interface GatewayDeps {
  /** The live flow registry listing. */
  listFlows(): readonly AuthorizationEntry[]
  /** Begin one authorization attempt. */
  begin(request: {
    key: CredentialKey
    interaction: AuthorizationInteraction
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }>
  /** Withdraw the running attempt for a key. */
  cancel(key: CredentialKey): void
  /** Record presence facts; undefined without a credential store. */
  describeRecord(key: CredentialKey): Promise<{ configured: boolean, kind?: string } | undefined>
  /** Delete the stored record; undefined without a credential store. */
  deleteRecord(key: CredentialKey): Promise<void>
  /** The resolved `llm-pi-ai` section, or undefined when unregistered. */
  settingsSection(): Record<string, unknown> | undefined
  /** The stored grant's usable model ids, or `undefined` when unknown. */
  models(): Promise<readonly string[] | undefined>
  /**
   * The installed pi-ai catalog models for the Copilot route, or `undefined`
   * when the llm service is unavailable. The narrow step needs the catalog's
   * ids: a profile `models` entry naming an id the catalog does not describe
   * would refuse the whole route at write time, because the shipped Copilot
   * models do not share one wire protocol to default it to.
   */
  catalogModels(): Promise<readonly { id: string }[] | undefined>
  /** Merge a patch into the `llm-pi-ai` user settings section. */
  updateSettings(patch: Record<string, unknown>): Promise<void>
  /**
   * The configured GitHub Enterprise domain, auto-answered for the Copilot
   * flow's enterprise question; blank or undefined serves github.com. A thunk
   * reads the live volatile config so a profile edit reaches the next sign-in.
   */
  enterpriseDomain?: string | (() => string)
}

/** Minimal structural types for the host webServer service. */
interface WebServerLike {
  register(options: {
    kind: 'prefix'
    path: string
    handler: (req: NodeRequest, res: NodeResponse) => Promise<void> | void
  }): () => void
}

interface NodeRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body: string): void
}

/** Sequenced event the gateway buffers: a notice or a pending prompt. */
type SequencedEvent =
  | { kind: 'notice', seq: number, notice: AuthorizationNotice }
  | { kind: 'prompt', seq: number, prompt: AuthorizationPrompt }

/**
 * Register the `/copilot/api` route.
 *
 * @param ctx - host context carrying `webServer`.
 * @param deps - the host capabilities the route drives.
 * @returns disposer removing the route.
 */
export function registerCopilotGateway(ctx: Context, deps: GatewayDeps): () => void {
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}

  // One in-flight login slot: sequence counter, replay ring, and the running
  // attempt's withdrawal. A second login call while one runs answers
  // `in-progress` with the current event cursor instead of failing the card.
  let seq = 0
  let ring: SequencedEvent[] = []
  let runningLogin: { key: CredentialKey, controller: AbortController } | undefined
  /** Last settlement, as a terminal event the client polls for. */
  let settlement: LoginOutcome | undefined

  const pushEvent = (event: SequencedEvent): number => {
    ring.push(event)
    if (ring.length > MAX_BUFFERED_NOTICES) ring = ring.slice(-MAX_BUFFERED_NOTICES)
    return event.seq
  }

  const pushNotice = (notice: AuthorizationNotice): number => {
    seq += 1
    return pushEvent({ kind: 'notice', seq, notice })
  }

  const pushPrompt = (prompt: AuthorizationPrompt): number => {
    seq += 1
    return pushEvent({ kind: 'prompt', seq, prompt })
  }

  const settle = (outcome: LoginOutcome): void => {
    runningLogin = undefined
    settlement = outcome
    pushNotice({ message: outcome.status === 'authorized'
      ? 'Authorized. The Copilot route is being activated…'
      : outcome.status === 'cancelled'
        ? 'Sign-in was cancelled.'
        : `Sign-in failed: ${outcome.message}` })
  }

  const copilotKey = (): CredentialKey | undefined => {
    const entry = findCopilotFlow(deps.listFlows())
    return entry?.key
  }

  const status = (): Promise<CopilotStatus> => joinStatus(deps)

  const runLogin = (): void => {
    const key = copilotKey()
    if (key === undefined) {
      settle({ status: 'error', message: 'no authorization flow is registered for llm-pi-ai/github-copilot (requires dsh-llm-pi-ai)' })
      return
    }
    if (runningLogin !== undefined) return
    const controller = new AbortController()
    runningLogin = { key, controller }
    settlement = undefined
    pushNotice({ message: 'Starting GitHub sign-in…' })
    void deps.begin({
      key,
      signal: controller.signal,
      interaction: {
        notify: (notice) => { pushNotice(notice) },
        prompt: (prompt) => {
          // Cheap path: the enterprise question is answered from configuration
          // without ever reaching the card, so the common sign-in goes
          // straight from the button to the device code. A configured domain
          // announces itself; blank needs no announcement — the device-code
          // notice lands within a moment either way.
          if (isEnterpriseDomainPrompt(prompt)) {
            const configured = typeof deps.enterpriseDomain === 'function' ? deps.enterpriseDomain() : deps.enterpriseDomain
            const domain = (configured ?? '').trim()
            if (domain !== '') pushNotice({ message: `Using GitHub Enterprise domain ${domain}.` })
            return Promise.resolve(domain)
          }
          return new Promise<string>((resolve, reject) => {
            const at = pushPrompt(prompt)
            prompt.signal?.addEventListener('abort', () => {
              pendingAnswers.delete(at)
              reject(new Error('prompt withdrawn'))
            }, { once: true })
            // The answer arrives via the `answer` method below.
            pendingAnswers.set(at, { resolve, reject })
          })
        },
      },
    }).then(
      async outcome => {
        if (outcome.status === 'authorized') {
          try {
            await autofill()
          } catch (error) {
            pushNotice({
              message: `Credential stored, but activating the provider profile failed: ${error instanceof Error ? error.message : String(error)} — retry from the card.`,
            })
          }
        }
        settle(outcome)
      },
      (error: unknown) => {
        settle(error instanceof AuthorizationDeclinedError
          ? { status: 'cancelled' }
          : { status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  /** Start the attempt and answer with the event cursor the card polls from. */
  const startLoginImmediate = (): number => {
    runLogin()
    return seq
  }

  const pendingAnswers = new Map<number, { resolve: (value: string) => void, reject: (reason?: unknown) => void }>()

  const answerPrompt = (answerSeq: number, answer: string, declined: boolean): boolean => {
    const waiter = pendingAnswers.get(answerSeq)
    if (waiter === undefined) return false
    pendingAnswers.delete(answerSeq)
    if (declined) waiter.reject(new AuthorizationDeclinedError())
    else waiter.resolve(answer)
    return true
  }

  /** The `github-copilot` profile of the resolved `llm-pi-ai` section, or undefined. */
  const copilotProfile = (): Record<string, unknown> | undefined => {
    const providers = deps.settingsSection()?.providers
    const profile = (providers as Record<string, unknown> | undefined)?.[COPILOT_PROVIDER]
    return typeof profile === 'object' && profile !== null ? profile as Record<string, unknown> : undefined
  }

  /**
   * The grant's available model ids narrowed to the installed catalog, in
     grant order. `undefined` when either side is unknown or the intersection
     is empty — narrowing to nothing would refuse the route at write time, so
     an unknown list leaves the installed catalog serving untouched.
   */
  const narrowedModels = async (): Promise<readonly string[] | undefined> => {
    const [available, catalog] = await Promise.all([deps.models(), deps.catalogModels()])
    if (available === undefined || catalog === undefined) return undefined
    if (available.length === 0 || catalog.length === 0) return undefined
    const known = new Set(catalog.map(model => model.id))
    const ids = available.filter(id => known.has(id))
    return ids.length > 0 ? ids : undefined
  }

  /** The `models` list ids a profile already carries, or undefined when it has none. */
  const profileModelIds = (profile: Record<string, unknown> | undefined): readonly string[] | undefined => {
    const models = profile?.models
    if (!Array.isArray(models) || !models.every(entry => typeof (entry as { id?: unknown })?.id === 'string')) {
      return undefined
    }
    return models.map(entry => (entry as { id: string }).id)
  }

  const sameStrings = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
    left !== undefined && right !== undefined
    && left.length === right.length && left.every((id, at) => id === right[at])

  /**
   * Ensure the provider profile exists and its `models` list matches what the
   * stored grant reports. The harness model picker serves the profile's
   * resolved list, so this — not pi-ai's request-time `filterModels`, which
   * the harness never consults — is what keeps unavailable models out of the
   * picker. One merged write carries profile creation and model narrowing
   * together; a profile already carrying the derived list costs no revision.
   * A list a user hand-wrote is treated as derived data and re-narrowed on
   * the next sync.
   * @returns what the call did, for the response envelope.
   */
  const autofill = async (): Promise<'created' | 'updated' | 'unchanged'> => {
    const profile = copilotProfile()
    const available = await narrowedModels()
    const narrowed = available?.map(id => ({ id }))
    const changed = narrowed !== undefined && !sameStrings(profileModelIds(profile), available)
    if (profile !== undefined && !changed) return 'unchanged'
    await deps.updateSettings({
      providers: { [COPILOT_PROVIDER]: changed && narrowed !== undefined ? { models: narrowed } : {} },
    })
    return profile === undefined ? 'created' : 'updated'
  }

  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if ((req.method ?? '') !== 'POST') {
        writeJson(res, 405, errorEnvelope('method-not-allowed', 'POST only'))
        return
      }
      const originCheck = sameOrigin(req)
      if (originCheck !== undefined) {
        writeJson(res, originCheck.status, errorEnvelope(originCheck.code, originCheck.message))
        return
      }
      const ct = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!ct.startsWith('application/json')) {
        writeJson(res, 415, errorEnvelope('content-type-not-supported', 'application/json required'))
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`)
        ? pathname.slice(`${API_PREFIX}/`.length)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, errorEnvelope('not-found', 'unknown copilot API method'))
        return
      }
      try {
        const body = await readJsonBody(req)
        switch (method) {
          case 'status': {
            writeJson(res, 200, okEnvelope(await status()))
            return
          }
          case 'login': {
            if (runningLogin !== undefined) {
              writeJson(res, 200, okEnvelope({ status: 'in-progress' as const, cursor: seq }))
              return
            }
            const immediate = startLoginImmediate()
            writeJson(res, 200, okEnvelope({ status: 'started' as const, cursor: immediate }))
            return
          }
          case 'cancel': {
            if (runningLogin === undefined) {
              writeJson(res, 200, okEnvelope({ status: 'not-running' as const }))
              return
            }
            runningLogin.controller.abort()
            writeJson(res, 200, okEnvelope({ status: 'cancelling' as const }))
            return
          }
          case 'events': {
            const since = typeof (body as { since?: unknown })?.since === 'number'
              ? (body as { since: number }).since
              : 0
            const events = ring
              .filter(event => event.seq > since)
              .map(event => event.kind === 'notice'
                ? {
                    seq: event.seq,
                    kind: 'notice' as const,
                    message: event.notice.message,
                    ...event.notice.url === undefined ? {} : { url: event.notice.url },
                    ...event.notice.code === undefined ? {} : { code: event.notice.code },
                  }
                : { seq: event.seq, kind: 'prompt' as const, prompt: event.prompt })
            writeJson(res, 200, okEnvelope({
              events,
              cursor: seq,
              inFlight: runningLogin !== undefined,
              ...settlement === undefined ? {} : { settlement },
            }))
            return
          }
          case 'answer': {
            const payload = body as { seq?: unknown, answer?: unknown, declined?: unknown }
            if (typeof payload.seq !== 'number') {
              writeJson(res, 400, errorEnvelope('bad-request', 'answer needs a numeric seq'))
              return
            }
            const declined = payload.declined === true
            // An empty answer is legitimate: pi-ai's Copilot flow reads the
            // blank enterprise question as "use github.com", so only a
            // non-string answer type is malformed, not an empty one.
            const answer = typeof payload.answer === 'string' ? payload.answer : ''
            writeJson(res, 200, okEnvelope({ accepted: answerPrompt(payload.seq, answer, declined) }))
            return
          }
          case 'logout': {
            const key = copilotKey()
            if (key === undefined) {
              writeJson(res, 200, okEnvelope({ status: 'not-running' as const }))
              return
            }
            const record = await deps.describeRecord(key)
            if (record?.configured !== true) {
              writeJson(res, 200, okEnvelope({ status: 'not-logged-in' as const }))
              return
            }
            await deps.deleteRecord(key)
            writeJson(res, 200, okEnvelope({ status: 'cleared' as const }))
            return
          }
          case 'autofill': {
            const before = copilotProfile() !== undefined
            await autofill()
            writeJson(res, 200, okEnvelope({ status: before ? 'already-active' as const : 'activated' as const }))
            return
          }
          default:
            writeJson(res, 404, errorEnvelope('not-found', `unknown copilot API method "${method}"`))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, 500, errorEnvelope('internal', message))
      }
    },
  })
}

/** Reject cross-site browser requests: same-origin only, like every plugin route. */
function sameOrigin(req: NodeRequest): { status: number, code: string, message: string } | undefined {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return { status: 400, code: 'invalid-origin', message: 'invalid Origin header' }
    }
    const reqHost = req.headers.host
    if (typeof reqHost === 'string' && originHost !== reqHost) {
      return { status: 403, code: 'origin-not-allowed', message: 'same-origin requests only' }
    }
  }
  return undefined
}

/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req: NodeRequest, maxBytes = 8192): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  return JSON.parse(text)
}

/** Write a JSON response envelope. */
function writeJson(res: NodeResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Build a success envelope. */
function okEnvelope<T>(value: T): { ok: true, value: T } {
  return { ok: true, value }
}

/** Build an error envelope. */
function errorEnvelope(code: string, message: string): { ok: false, error: { code: string, message: string } } {
  return { ok: false, error: { code, message } }
}
