/**
 * `CopilotAuthController` — client-side state machine for the Copilot card.
 *
 * Drives the host's `/copilot/api` gateway: one `status` load, a login flow
 * that starts the attempt and then polls the sequenced `events` stream
 * (device-code notices, progress, prompts to answer) until the attempt
 * settles, and logout / autofill actions. The store is the single render
 * source; the card is a pure projection of it.
 *
 * @module @huanlin/dsh-plugin-copilot/client/controller
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CopilotStatus } from '../status.ts'

/** One sequenced gateway event as the client consumes it. */
export interface CopilotClientEvent {
  seq: number
  kind: 'notice' | 'prompt'
  message?: string
  url?: string
  code?: string
  prompt?: { kind: 'text' | 'secret' | 'select', message: string, placeholder?: string, options?: readonly { id: string, label: string }[] }
}

/** The card's render state. */
export interface CopilotCardState {
  /** Whether the first status read answered. */
  loaded: boolean
  /** The joined host status. */
  status: CopilotStatus
  /** Login lifecycle: idle / running / terminal outcome. */
  login:
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'success' }
    | { kind: 'error', message: string }
    | { kind: 'cancelled' }
  /** Notices and the latest unanswered prompt, in arrival order. */
  events: readonly CopilotClientEvent[]
  /** The last device code shown (for the copy button). */
  deviceCode: string | undefined
  /** The verification URL of the latest device-code notice. */
  verificationUrl: string | undefined
  /** The prompt awaiting an answer, when one is open. */
  openPrompt: CopilotClientEvent | undefined
  /** Copy button feedback. */
  copied: boolean
  /** Action in flight (disables buttons). */
  busy: boolean
}

/** Initial state before the first load. */
function initialState(): CopilotCardState {
  return {
    loaded: false,
    status: { flowAvailable: false, loggedIn: false, profileActivated: false, inFlight: false, models: undefined },
    login: { kind: 'idle' },
    events: [],
    deviceCode: undefined,
    verificationUrl: undefined,
    openPrompt: undefined,
    copied: false,
    busy: false,
  }
}

/** One gateway call's result envelope. */
interface Envelope<T> {
  ok?: boolean
  value?: T
  error?: { code?: string, message?: string }
}

/** Call one `/copilot/api/<method>` endpoint. */
async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/copilot/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const parsed = await response.json().catch(() => null) as Envelope<T> | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value
}

/**
 * Controller managing the Copilot card lifecycle. Constructed once in the
 * client `apply()`; polls only while a login attempt is running or the card
 * holds an unanswered prompt.
 */
export class CopilotAuthController {
  readonly store: SnapshotStore<CopilotCardState>
  private cursor = 0
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor() {
    this.store = createSnapshotStore<CopilotCardState>(initialState())
  }

  /** Load the joined status from the host. */
  async load(): Promise<void> {
    try {
      const status = await call<CopilotStatus>('status')
      this.store.update((s) => {
        s.loaded = true
        s.status = status
        if (status.inFlight && s.login.kind === 'idle') {
          s.login = { kind: 'running' }
          this.schedulePoll(0)
        }
      })
    } catch {
      this.store.update((s) => { s.loaded = true })
    }
  }

  /** Start a login attempt, then poll events until settlement. */
  async login(): Promise<void> {
    if (this.disposed) return
    this.store.update((s) => {
      s.busy = true
      s.login = { kind: 'running' }
      s.events = []
      s.deviceCode = undefined
      s.verificationUrl = undefined
      s.openPrompt = undefined
    })
    try {
      const start = await call<{ status: string, cursor?: number }>('login')
      this.cursor = start.cursor ?? this.cursor
    } catch (error) {
      this.finishLogin('error', error instanceof Error ? error.message : String(error))
      return
    }
    this.store.update((s) => { s.busy = false })
    // The attempt runs on the host; the event stream carries device codes,
    // prompts, and the terminal settlement.
    this.schedulePoll(0)
  }

  /** Withdraw the running attempt. */
  async cancel(): Promise<void> {
    this.store.update((s) => { s.busy = true })
    try {
      await call('cancel')
    } catch {
      // The settlement poll below is the authority; ignore transport noise.
    }
    this.store.update((s) => { s.busy = false })
  }

  /** Answer the open prompt. */
  async answer(answer: string, declined: boolean): Promise<void> {
    const prompt = this.store.getSnapshot().openPrompt
    if (prompt === undefined) return
    this.store.update((s) => {
      s.busy = true
      s.openPrompt = undefined
    })
    try {
      await call('answer', { seq: prompt.seq, answer, declined })
    } catch {
      // A withdrawn prompt re-appears through the next event poll if the
      // attempt still needs an answer; nothing else to do here.
    }
    this.store.update((s) => { s.busy = false })
    this.schedulePoll(0)
  }

  /** Delete the stored credential record. */
  async logout(): Promise<void> {
    this.store.update((s) => { s.busy = true })
    try {
      await call('logout')
      await this.load()
    } catch {
      // The next card mount re-reads status; surface nothing extra.
    }
    this.store.update((s) => { s.busy = false })
  }

  /** Write the provider profile (idempotent on the host side). */
  async autofill(): Promise<void> {
    this.store.update((s) => { s.busy = true })
    try {
      await call('autofill')
      await this.load()
    } catch {
      // Status reload below keeps the card honest even when the write failed.
      await this.load()
    }
    this.store.update((s) => { s.busy = false })
  }

  /** Copy-button feedback. */
  markCopied(): void {
    this.store.update((s) => { s.copied = true })
    setTimeout(() => {
      if (!this.disposed) this.store.update((s) => { s.copied = false })
    }, 1500)
  }

  /** Stop polling and further actions; called on fiber disposal. */
  dispose(): void {
    this.disposed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  /** Fold one settlement into the card state and refresh the join. */
  private finishLogin(status: string, message?: string): void {
    this.store.update((s) => {
      s.busy = false
      if (status === 'authorized') {
        s.login = { kind: 'success' }
        s.status = { ...s.status, loggedIn: true, profileActivated: true }
      } else if (status === 'cancelled') {
        s.login = { kind: 'cancelled' }
      } else {
        s.login = { kind: 'error', message: message ?? 'Sign-in failed' }
      }
    })
    void this.load()
  }

  /** Poll the event stream once; reschedules while the attempt runs. */
  private async pollOnce(): Promise<void> {
    if (this.disposed) return
    let delay = 1000
    try {
      const answer = await call<{
        events: CopilotClientEvent[]
        cursor: number
        inFlight: boolean
        settlement?: { status: string, message?: string }
      }>('events', { since: this.cursor })
      this.cursor = answer.cursor
      for (const event of answer.events) this.applyEvent(event)
      if (answer.settlement !== undefined && this.store.getSnapshot().login.kind === 'running') {
        this.finishLogin(answer.settlement.status, answer.settlement.message)
        return
      }
      if (answer.inFlight) delay = 1000
      else {
        // The attempt is over and no settlement is carried (e.g. it settled
        // before this controller started polling): reload the join and stop.
        void this.load()
        return
      }
    } catch {
      delay = 2000
    }
    this.schedulePoll(delay)
  }

  /** Fold one sequenced event into the card state. */
  private applyEvent(event: CopilotClientEvent): void {
    this.store.update((s) => {
      s.events = [...s.events, event].slice(-24)
      if (event.kind === 'prompt') {
        s.openPrompt = event
        return
      }
      if (event.code !== undefined) {
        s.deviceCode = event.code
        s.verificationUrl = event.url
      }
    })
  }

  /** Schedule the next poll, collapsing overlapping timers. */
  private schedulePoll(delayMs: number): void {
    if (this.disposed) return
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.pollOnce()
    }, delayMs)
  }
}
