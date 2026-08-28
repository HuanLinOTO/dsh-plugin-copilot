/**
 * Unit tests for the /copilot/api gateway: envelope discipline, the login
 * attempt lifecycle (device-flow notices, prompt relay, cancel, autofill on
 * success), and the stateless methods (status / events / logout / autofill).
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationEntry, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { GatewayDeps } from '../src/gateway.ts'
import { registerCopilotGateway } from '../src/gateway.ts'

const COPILOT_KEY = credentialKey('llm-pi-ai', 'github-copilot')

/** One captured gateway interaction. */
interface Recorded {
  notices: AuthorizationNotice[]
  prompts: AuthorizationPrompt[]
  cancelled: number
  deleted: number
  settingsPatches: Record<string, unknown>[]
}

/**
 * A `begin` implementation driving a scripted device flow: notify the code,
 * optionally ask a prompt, then resolve authorized (or cancelled / throw).
 */
function scriptedBegin(
  recorded: Recorded,
  script: { prompt?: AuthorizationPrompt, settle: 'authorized' | 'cancelled' | 'throw' },
): GatewayDeps['begin'] {
  return async ({ key, interaction }) => {
    expect(key).toBe(COPILOT_KEY)
    interaction.notify({
      message: 'Enter this code on the verification page to finish signing in.',
      url: 'https://github.com/login/device',
      code: 'ABCD-1234',
    })
    if (script.prompt !== undefined) {
      recorded.prompts.push(script.prompt)
      await interaction.prompt(script.prompt)
      interaction.notify({ message: 'Answer received.' })
    }
    if (script.settle === 'authorized') return { status: 'authorized' }
    if (script.settle === 'cancelled') return { status: 'cancelled' }
    throw new Error('device flow exploded')
  }
}

interface Harness {
  request(method: string, body?: unknown, headers?: Record<string, string>, httpMethod?: string): Promise<{ status: number, body: any }>
  recorded: Recorded
  dispose: () => void
}

/**
 * The real mount path: registerCopilotGateway against a fake webServer that
 * captures the handler, answering requests from in-memory objects.
 */
function mountWithServer(deps: Partial<GatewayDeps> & Pick<GatewayDeps, 'begin'>): Harness {
  const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
  let handler: ((req: unknown, res: unknown) => Promise<void> | void) | undefined
  const ctx = {
    webServer: {
      register: (route: { handler: (req: unknown, res: unknown) => Promise<void> | void }) => {
        handler = route.handler
        return () => { handler = undefined }
      },
    },
    effect: (fn: () => () => void) => fn(),
  } as unknown as Context
  const flows: AuthorizationEntry[] = [
    {
      key: COPILOT_KEY,
      label: 'GitHub Copilot',
      methods: [{ id: 'oauth', label: 'OAuth' }],
      inFlight: false,
    },
  ]
  const full: GatewayDeps = {
    listFlows: () => flows,
    cancel: () => { recorded.cancelled += 1 },
    describeRecord: async () => ({ configured: false }),
    deleteRecord: async () => { recorded.deleted += 1 },
    settingsSection: () => undefined,
    models: async () => undefined,
    catalogModels: async () => undefined,
    updateSettings: async patch => { recorded.settingsPatches.push(patch) },
    ...deps,
  }
  const dispose = registerCopilotGateway(ctx, full)
  const request = async (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    httpMethod = 'POST',
  ): Promise<{ status: number, body: any }> => {
    if (handler === undefined) throw new Error('gateway not mounted')
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method: httpMethod,
      url: `/copilot/api/${method}`,
      headers: { host: '127.0.0.1:18080', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    let status = 0
    let payload = ''
    const res = {
      writeHead: (code: number, outHeaders: Record<string, string>) => {
        status = code
        void outHeaders
      },
      end: (text: string) => { payload = text },
    }
    await handler(req, res)
    return { status, body: payload === '' ? null : JSON.parse(payload) }
  }
  return { request, recorded, dispose }
}

/** Wait until the gateway's event stream reports the attempt no longer running. */
async function waitForSettlement(h: Harness): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    const events = await h.request('events', { since: 0 })
    if (events.body.value.inFlight === false && events.body.value.settlement !== undefined) {
      return events.body.value
    }
  }
  throw new Error('settlement never arrived')
}

describe('copilot gateway', () => {
  it('answers status with the joined facts, including the account models', async () => {
    const h = mountWithServer({
      describeRecord: async key => key === COPILOT_KEY ? { configured: true, kind: 'grant' } : undefined,
      settingsSection: () => ({ providers: { 'github-copilot': {} } }),
      models: async () => ['gpt-4.1', 'claude-sonnet-4.5'],
      begin: async () => { throw new Error('unused') },
    })
    const response = await h.request('status')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      value: {
        flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false,
        models: ['gpt-4.1', 'claude-sonnet-4.5'],
      },
    })
    h.dispose()
  })

  it('drives a device-flow login to authorized, with autofill', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({ begin: scriptedBegin(recorded, { settle: 'authorized' }) })
    const login = await h.request('login')
    expect(login.body.value.status).toBe('started')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('authorized')
    // autofill wrote the minimal profile
    expect(h.recorded.settingsPatches).toEqual([{ providers: { 'github-copilot': {} } }])
    // the device code notice is replayable through events
    const codeEvent = settled.events.find((event: any) => event.code === 'ABCD-1234')
    expect(codeEvent).toMatchObject({ kind: 'notice', url: 'https://github.com/login/device' })
    h.dispose()
  })

  it('relays a prompt and accepts the browser answer', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({
      begin: scriptedBegin(recorded, {
        prompt: { kind: 'text', message: 'Enter the 8-digit code' },
        settle: 'authorized',
      }),
    })
    await h.request('login')
    let promptSeq: number | undefined
    for (let attempt = 0; attempt < 100 && promptSeq === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const events = await h.request('events', { since: 0 })
      promptSeq = events.body.value.events.find((event: any) => event.kind === 'prompt')?.seq
    }
    expect(promptSeq).toBeDefined()
    const answer = await h.request('answer', { seq: promptSeq, answer: '12345678' })
    expect(answer.body.value.accepted).toBe(true)
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('authorized')
    h.dispose()
  })

  it('accepts an empty manual answer for an unmatched optional prompt', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({
      begin: scriptedBegin(recorded, {
        prompt: { kind: 'text', message: 'Optional notes (blank to skip)' },
        settle: 'authorized',
      }),
    })
    await h.request('login')
    let promptSeq: number | undefined
    for (let attempt = 0; attempt < 100 && promptSeq === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const events = await h.request('events', { since: 0 })
      promptSeq = events.body.value.events.find((event: any) => event.kind === 'prompt')?.seq
    }
    expect(promptSeq).toBeDefined()
    const answer = await h.request('answer', { seq: promptSeq, answer: '' })
    expect(answer.status).toBe(200)
    expect(answer.body.value.accepted).toBe(true)
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('authorized')
    h.dispose()
  })

  it('auto-answers the enterprise question blank (cheap github.com path, no prompt reaches the card)', async () => {
    let answered: string | undefined
    const h = mountWithServer({
      begin: async ({ interaction }) => {
        answered = await interaction.prompt({ kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' })
        interaction.notify({ message: 'Enter this code…', url: 'https://github.com/login/device', code: 'ABCD-1234' })
        return { status: 'authorized' }
      },
    })
    await h.request('login')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('authorized')
    expect(answered).toBe('')
    const events = await h.request('events', { since: 0 })
    expect(events.body.value.events.some((event: any) => event.kind === 'prompt')).toBe(false)
    h.dispose()
  })

  it('auto-answers the enterprise question with the configured enterprise domain', async () => {
    let answered: string | undefined
    const h = mountWithServer({
      enterpriseDomain: 'company.ghe.com',
      begin: async ({ interaction }) => {
        answered = await interaction.prompt({ kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' })
        return { status: 'authorized' }
      },
    })
    await h.request('login')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('authorized')
    expect(answered).toBe('company.ghe.com')
    h.dispose()
  })

  it('maps a declined prompt to cancelled', async () => {
    const h = mountWithServer({
      begin: async ({ interaction }) => {
        interaction.notify({ message: 'Enter code', code: 'ABCD-1234' })
        await interaction.prompt({ kind: 'text', message: 'Enter the code' })
        throw new (await import('@deepseek-ai/dsh-authorization')).AuthorizationDeclinedError()
      },
    })
    await h.request('login')
    let promptSeq: number | undefined
    for (let attempt = 0; attempt < 100 && promptSeq === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const events = await h.request('events', { since: 0 })
      promptSeq = events.body.value.events.find((event: any) => event.kind === 'prompt')?.seq
    }
    const answer = await h.request('answer', { seq: promptSeq, declined: true })
    expect(answer.body.value.accepted).toBe(true)
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('cancelled')
    h.dispose()
  })

  it('maps a begin failure to an error settlement', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({ begin: scriptedBegin(recorded, { settle: 'throw' }) })
    await h.request('login')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('error')
    expect(settled.settlement.message).toContain('exploded')
    h.dispose()
  })

  it('refuses a second concurrent login with in-progress', async () => {
    const h = mountWithServer({
      begin: async ({ interaction, signal }) => {
        interaction.notify({ message: 'Enter code', code: 'XYZ', url: 'https://github.com/login/device' })
        return new Promise<{ status: 'authorized' | 'cancelled' }>((resolve) => {
          signal?.addEventListener('abort', () => { resolve({ status: 'cancelled' }) }, { once: true })
        })
      },
    })
    const first = await h.request('login')
    expect(first.body.value.status).toBe('started')
    const second = await h.request('login')
    expect(second.body.value.status).toBe('in-progress')
    expect(typeof second.body.value.cursor).toBe('number')
    // cancel withdraws the attempt; the event stream settles cancelled
    const cancelled = await h.request('cancel')
    expect(cancelled.body.value.status).toBe('cancelling')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('cancelled')
    h.dispose()
  })

  it('answers not-running when cancel has no attempt', async () => {
    const h = mountWithServer({ begin: async () => { throw new Error('unused') } })
    const response = await h.request('cancel')
    expect(response.body.value.status).toBe('not-running')
    h.dispose()
  })

  it('deletes the record on logout and reports not-logged-in when absent', async () => {
    const configured = { value: true }
    const h = mountWithServer({
      begin: async () => { throw new Error('unused') },
      describeRecord: async () => ({ configured: configured.value, kind: 'grant' }),
      deleteRecord: async () => { configured.value = false },
    })
    const miss = await h.request('logout')
    expect(miss.body.value.status).toBe('cleared')
    const again = await h.request('logout')
    expect(again.body.value.status).toBe('not-logged-in')
    h.dispose()
  })

  it('autofill is idempotent for an already-active profile', async () => {
    const h = mountWithServer({
      begin: async () => { throw new Error('unused') },
      settingsSection: () => ({ providers: { 'github-copilot': {} } }),
    })
    const result = await h.request('autofill')
    expect(result.body.value.status).toBe('already-active')
    expect(h.recorded.settingsPatches).toEqual([])
    h.dispose()
  })

  it('autofill writes the profile when dormant', async () => {
    const h = mountWithServer({ begin: async () => { throw new Error('unused') } })
    const result = await h.request('autofill')
    expect(result.body.value.status).toBe('activated')
    expect(h.recorded.settingsPatches).toEqual([{ providers: { 'github-copilot': {} } }])
    h.dispose()
  })

  it('narrows the profile models list to the installed catalog on login', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({
      begin: scriptedBegin(recorded, { settle: 'authorized' }),
      models: async () => ['gpt-4.1', 'ghost-model', 'claude-sonnet-4.5'],
      catalogModels: async () => [{ id: 'gpt-4.1' }, { id: 'claude-sonnet-4.5' }],
    })
    await h.request('login')
    await waitForSettlement(h)
    expect(h.recorded.settingsPatches).toEqual([
      { providers: { 'github-copilot': { models: [{ id: 'gpt-4.1' }, { id: 'claude-sonnet-4.5' }] } } },
    ])
    h.dispose()
  })

  it('skips the settings write when the profile already carries the derived models list', async () => {
    const recorded: Recorded = { notices: [], prompts: [], cancelled: 0, deleted: 0, settingsPatches: [] }
    const h = mountWithServer({
      begin: scriptedBegin(recorded, { settle: 'authorized' }),
      models: async () => ['gpt-4.1'],
      catalogModels: async () => [{ id: 'gpt-4.1' }],
      settingsSection: () => ({ providers: { 'github-copilot': { models: [{ id: 'gpt-4.1' }] } } }),
    })
    await h.request('login')
    await waitForSettlement(h)
    expect(h.recorded.settingsPatches).toEqual([])
    h.dispose()
  })

  it('autofill syncs the models list even when the profile is already active', async () => {
    const h = mountWithServer({
      begin: async () => { throw new Error('unused') },
      models: async () => ['gpt-4.1', 'ghost-model'],
      catalogModels: async () => [{ id: 'gpt-4.1' }],
      settingsSection: () => ({ providers: { 'github-copilot': {} } }),
    })
    const result = await h.request('autofill')
    expect(result.body.value.status).toBe('already-active')
    expect(h.recorded.settingsPatches).toEqual([
      { providers: { 'github-copilot': { models: [{ id: 'gpt-4.1' }] } } },
    ])
    h.dispose()
  })

  it('reports the missing flow as an error settlement', async () => {
    const h = mountWithServer({
      listFlows: () => [],
      begin: async () => { throw new Error('unused') },
    })
    const login = await h.request('login')
    expect(login.body.value.status).toBe('started')
    const settled = await waitForSettlement(h)
    expect(settled.settlement.status).toBe('error')
    expect(settled.settlement.message).toContain('dsh-llm-pi-ai')
    h.dispose()
  })

  it('rejects cross-origin requests', async () => {
    const h = mountWithServer({ begin: async () => { throw new Error('unused') } })
    const response = await h.request('status', {}, { origin: 'https://evil.example' })
    expect(response.status).toBe(403)
    h.dispose()
  })

  it('answers 404 for unknown methods and 405 for GET', async () => {
    const h = mountWithServer({ begin: async () => { throw new Error('unused') } })
    expect((await h.request('bogus')).status).toBe(404)
    expect((await h.request('status', undefined, undefined, 'GET')).status).toBe(405)
    h.dispose()
  })
})
