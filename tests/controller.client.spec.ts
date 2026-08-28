/** @vitest-environment jsdom */
/**
 * Client controller unit tests: status load, login lifecycle with the
 * sequenced event stream, prompt answers, and disposal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopilotAuthController } from '../src/client/controller.ts'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, value }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface ScriptedRoute {
  method: string
  body?: unknown
  respond: () => unknown
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(routes: ScriptedRoute[]): vi.Mock {
  const remaining = new Map(routes.map(route => [route.method, route]))
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).replace('/copilot/api/', '')
    const route = remaining.get(method)
    if (route === undefined) throw new Error(`unexpected call: ${method}`)
    if (route.body !== undefined) expect(JSON.parse(String(init?.body ?? '{}'))).toEqual(route.body)
    return jsonResponse(route.respond()) as unknown as Response
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('CopilotAuthController', () => {
  it('loads status into the store', async () => {
    stubFetch([{
      method: 'status',
      respond: () => ({ flowAvailable: true, loggedIn: true, profileActivated: false, inFlight: false }),
    }])
    const controller = new CopilotAuthController()
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.loaded).toBe(true)
    expect(state.status.loggedIn).toBe(true)
    expect(state.status.profileActivated).toBe(false)
    controller.dispose()
  })

  it('joins an in-flight attempt by polling events', async () => {
    const fetchMock = stubFetch([
      { method: 'login', respond: () => ({ status: 'started', cursor: 1 }) },
      {
        method: 'events',
        body: { since: 1 },
        respond: () => ({
          events: [{
            seq: 2,
            kind: 'notice',
            message: 'Enter this code on the verification page to finish signing in.',
            url: 'https://github.com/login/device',
            code: 'ABCD-1234',
          }],
          cursor: 2,
          inFlight: true,
        }),
      },
    ])
    const controller = new CopilotAuthController()
    await controller.login()
    // the attempt runs on the host; the card learns the device code by polling
    await new Promise(resolve => setTimeout(resolve, 30))
    const state = controller.store.getSnapshot()
    expect(state.deviceCode).toBe('ABCD-1234')
    expect(state.verificationUrl).toBe('https://github.com/login/device')
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('events')).length).toBeGreaterThanOrEqual(1)
    controller.dispose()
  })

  it('finishes the login on the settlement the events stream carries', async () => {
    stubFetch([
      { method: 'login', respond: () => ({ status: 'started', cursor: 1 }) },
      {
        method: 'events',
        body: { since: 1 },
        respond: () => ({
          events: [{ seq: 2, kind: 'notice', message: 'Authorized. The Copilot route is being activated…' }],
          cursor: 2,
          inFlight: false,
          settlement: { status: 'authorized' },
        }),
      },
      {
        method: 'status',
        respond: () => ({ flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false }),
      },
    ])
    const controller = new CopilotAuthController()
    await controller.login()
    await new Promise(resolve => setTimeout(resolve, 30))
    const state = controller.store.getSnapshot()
    expect(state.login.kind).toBe('success')
    expect(state.status.loggedIn).toBe(true)
    controller.dispose()
  })

  it('maps an error settlement to the error state with its message', async () => {
    stubFetch([
      { method: 'login', respond: () => ({ status: 'started', cursor: 1 }) },
      {
        method: 'events',
        body: { since: 1 },
        respond: () => ({
          events: [],
          cursor: 1,
          inFlight: false,
          settlement: { status: 'error', message: 'boom' },
        }),
      },
      {
        method: 'status',
        respond: () => ({ flowAvailable: true, loggedIn: false, profileActivated: false, inFlight: false }),
      },
    ])
    const controller = new CopilotAuthController()
    await controller.login()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(controller.store.getSnapshot().login).toEqual({ kind: 'error', message: 'boom' })
    controller.dispose()
  })

  it('surfaces a login transport failure immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const controller = new CopilotAuthController()
    await controller.login()
    expect(controller.store.getSnapshot().login).toEqual({ kind: 'error', message: 'network down' })
    controller.dispose()
  })

  it('answers an open prompt and clears it', async () => {
    stubFetch([
      { method: 'answer', body: { seq: 3, answer: '1234', declined: false }, respond: () => ({ accepted: true }) },
      { method: 'events', body: { since: 3 }, respond: () => ({ events: [], cursor: 3, inFlight: true }) },
    ])
    const controller = new CopilotAuthController()
    controller.store.update((draft) => {
      draft.openPrompt = { seq: 3, kind: 'prompt', prompt: { kind: 'text', message: 'Enter code' } }
    })
    await controller.answer('1234', false)
    expect(controller.store.getSnapshot().openPrompt).toBeUndefined()
    controller.dispose()
  })

  it('logout refreshes status', async () => {
    const fetchMock = stubFetch([
      { method: 'logout', respond: () => ({ status: 'cleared' }) },
      { method: 'status', respond: () => ({ flowAvailable: true, loggedIn: false, profileActivated: true, inFlight: false }) },
    ])
    const controller = new CopilotAuthController()
    await controller.logout()
    expect(controller.store.getSnapshot().status.loggedIn).toBe(false)
    expect(fetchMock.mock.calls.length).toBe(2)
    controller.dispose()
  })

  it('autofill refreshes status after writing', async () => {
    const fetchMock = stubFetch([
      { method: 'autofill', respond: () => ({ status: 'activated' }) },
      { method: 'status', respond: () => ({ flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false }) },
    ])
    const controller = new CopilotAuthController()
    await controller.autofill()
    expect(controller.store.getSnapshot().status.profileActivated).toBe(true)
    expect(fetchMock.mock.calls.length).toBe(2)
    controller.dispose()
  })

  it('dispose stops polling', async () => {
    const fetchMock = stubFetch([
      { method: 'events', body: { since: 0 }, respond: () => ({ events: [], cursor: 0, inFlight: true }) },
    ])
    const controller = new CopilotAuthController()
    controller.store.update((draft) => { draft.login = { kind: 'running' } })
    controller.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fetchMock.mock.calls.length).toBe(0)
  })
})
