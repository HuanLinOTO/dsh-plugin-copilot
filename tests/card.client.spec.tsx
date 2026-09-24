/** @vitest-environment jsdom */
/**
 * Card state-machine rendering specs: unsupported, logged-out, pending with
 * device code, success, and error arms — asserting user-visible copy, not
 * class names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CopilotAuthCard } from '../src/client/CopilotAuthCard.tsx'
import type { CopilotCardState } from '../src/client/controller.ts'
import { CopilotAuthController } from '../src/client/controller.ts'
import { en, type CopilotKey } from '../src/client/locales.ts'
import { bindSnapshotSelector } from '../src/client/bindSnapshotSelector.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const t = (key: CopilotKey): string => en[key]

function stateWith(overrides: Partial<CopilotCardState>): CopilotCardState {
  return {
    loaded: true,
    status: { flowAvailable: true, loggedIn: false, profileActivated: false, inFlight: false, models: undefined },
    login: { kind: 'idle' },
    events: [],
    deviceCode: undefined,
    verificationUrl: undefined,
    openPrompt: undefined,
    copied: false,
    busy: false,
    ...overrides,
  }
}

/** Render the card against a frozen state snapshot and capture the DOM. */
function renderState(state: CopilotCardState): HTMLElement {
  const controller = new CopilotAuthController()
  controller.store.update((draft) => { Object.assign(draft, state) })
  const useCard = bindSnapshotSelector(controller.store)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(createElement(CopilotAuthCard, {
      t,
      controller,
      useCard,
    }))
  })
  return host
}

let roots: Root[] = []
beforeEach(() => {
  roots = []
})

afterEach(async () => {
  for (const root of roots) {
    root.unmount()
  }
  document.body.innerHTML = ''
})

describe('CopilotAuthCard', () => {
  it('renders the signed-out state with a sign-in button', () => {
    const host = renderState(stateWith({}))
    expect(host.textContent).toContain('Not signed in')
    const signIn = [...host.querySelectorAll('button')].find(button => button.textContent === 'Sign in with GitHub')
    expect(signIn).toBeDefined()
  })

  it('renders the unsupported state naming the prerequisite', () => {
    const host = renderState(stateWith({
      status: { flowAvailable: false, loggedIn: false, profileActivated: false, inFlight: false, models: undefined },
    }))
    expect(host.textContent).toContain('dsh-llm-pi-ai')
    const signIn = [...host.querySelectorAll('button')].find(button => button.textContent === 'Sign in with GitHub')
    expect(signIn).toBeUndefined()
  })

  it('renders the device code with copy and a popup-window open action while pending', () => {
    const host = renderState(stateWith({
      login: { kind: 'running' },
      deviceCode: 'ABCD-1234',
      verificationUrl: 'https://github.com/login/device',
    }))
    expect(host.textContent).toContain('ABCD-1234')
    expect(host.textContent).toContain('Waiting for authorization')
    const openPage = vi.spyOn(window, 'open').mockReturnValue(null)
    const openUrl = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open verification page')
    expect(openUrl).toBeDefined()
    act(() => {
      openUrl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(openPage).toHaveBeenCalledWith(
      'https://github.com/login/device', '_blank', 'noopener,noreferrer,width=960,height=760')
    expect(host.querySelector('a')).toBeNull()
    openPage.mockRestore()
    const copy = [...host.querySelectorAll('button')].find(button => button.textContent === 'Copy code')
    expect(copy).toBeDefined()
  })

  it('renders the logged-in state with sign-out and no dormant badge', () => {
    const host = renderState(stateWith({
      status: { flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false, models: undefined },
    }))
    expect(host.textContent).toContain('Signed in')
    expect(host.textContent).toContain('Route active')
    const signOut = [...host.querySelectorAll('button')].find(button => button.textContent === 'Sign out')
    expect(signOut).toBeDefined()
    const syncModels = [...host.querySelectorAll('button')].find(button => button.textContent === 'Sync model list')
    expect(syncModels).toBeDefined()
  })

  it('lists the model ids the account can use when signed in', () => {
    const host = renderState(stateWith({
      status: {
        flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false,
        models: ['gpt-4.1', 'claude-sonnet-4.5'],
      },
    }))
    expect(host.textContent).toContain('Models available to this account')
    expect(host.textContent).toContain('gpt-4.1, claude-sonnet-4.5')
  })

  it('offers route activation when signed in but dormant', () => {
    const host = renderState(stateWith({
      status: { flowAvailable: true, loggedIn: true, profileActivated: false, inFlight: false, models: undefined },
    }))
    const activate = [...host.querySelectorAll('button')].find(button => button.textContent === 'Activate route')
    expect(activate).toBeDefined()
  })

  it('renders an open prompt with the message on its own line and an enabled empty submit', () => {
    const host = renderState(stateWith({
      login: { kind: 'running' },
      openPrompt: {
        seq: 2,
        kind: 'prompt',
        prompt: { kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)', placeholder: 'company.ghe.com' },
      },
    }))
    const message = [...host.querySelectorAll('p')].find(p => p.textContent === 'GitHub Enterprise URL/domain (blank for github.com)')
    expect(message).toBeDefined()
    const input = host.querySelector('input')
    expect(input).toBeDefined()
    expect(input?.getAttribute('placeholder')).toBe('company.ghe.com')
    const submit = [...host.querySelectorAll('button')].find(button => button.textContent === 'Submit')
    expect(submit).toBeDefined()
    expect(submit?.disabled).toBe(false)
    const decline = [...host.querySelectorAll('button')].find(button => button.textContent === 'Decline')
    expect(decline).toBeDefined()
  })

  it('renders the success state without a navigation link', () => {
    const host = renderState(stateWith({ login: { kind: 'success' } }))
    expect(host.textContent).toContain('Signed in. The Copilot models are ready')
    expect(host.querySelector('a')).toBeNull()
  })

  it('renders the error state with the failure message and retry', () => {
    const host = renderState(stateWith({ login: { kind: 'error', message: 'token endpoint unreachable' } }))
    expect(host.textContent).toContain('token endpoint unreachable')
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')
    expect(retry).toBeDefined()
  })
})
