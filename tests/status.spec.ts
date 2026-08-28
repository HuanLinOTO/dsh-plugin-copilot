/**
 * Unit tests for the status join: flow discovery, record × profile joins,
 * and the defensive arms (no flow, no store, malformed sections).
 */
import { describe, expect, it } from 'vitest'
import type { AuthorizationEntry } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { findCopilotFlow, grantModelIds, joinStatus, recordAddress } from '../src/status.ts'

function entry(scope: string, id: string, inFlight = false): AuthorizationEntry {
  return {
    key: credentialKey(scope, id),
    label: `${scope}/${id}`,
    methods: [{ id: 'oauth', label: 'OAuth' }],
    inFlight,
  }
}

describe('recordAddress', () => {
  it('joins the two segments', () => {
    expect(recordAddress(credentialKey('llm-pi-ai', 'github-copilot'))).toBe('llm-pi-ai/github-copilot')
  })
})

describe('findCopilotFlow', () => {
  it('finds the pi-ai copilot entry among others', () => {
    const flows = [entry('llm-pi-ai', 'openai'), entry('llm-pi-ai', 'github-copilot'), entry('other', 'github-copilot')]
    expect(findCopilotFlow(flows)?.key).toBe(credentialKey('llm-pi-ai', 'github-copilot'))
  })

  it('returns undefined without the copilot flow', () => {
    expect(findCopilotFlow([entry('llm-pi-ai', 'openai')])).toBeUndefined()
    expect(findCopilotFlow([])).toBeUndefined()
  })
})

describe('grantModelIds', () => {
  it('reads availableModelIds from a pi-ai oauth grant payload', () => {
    expect(grantModelIds({
      kind: 'grant',
      payload: { type: 'oauth', access: 'tok', availableModelIds: ['gpt-4.1', 'claude-sonnet-4.5'] },
    })).toEqual(['gpt-4.1', 'claude-sonnet-4.5'])
  })

  it('reads unknown for anything that is not a well-formed oauth grant', () => {
    expect(grantModelIds(undefined)).toBeUndefined()
    expect(grantModelIds({ kind: 'api-key' })).toBeUndefined()
    expect(grantModelIds({ kind: 'grant', payload: {} })).toBeUndefined()
    expect(grantModelIds({ kind: 'grant', payload: { availableModelIds: 'all' } })).toBeUndefined()
    expect(grantModelIds({ kind: 'grant', payload: { availableModelIds: ['ok', 42] } })).toBeUndefined()
  })
})

describe('joinStatus', () => {
  const copilotKey = credentialKey('llm-pi-ai', 'github-copilot')

  it('joins record and profile into the card status, with the account models', async () => {
    const status = await joinStatus({
      listFlows: () => [entry('llm-pi-ai', 'github-copilot')],
      describeRecord: async key => key === copilotKey ? { configured: true, kind: 'grant' } : undefined,
      settingsSection: () => ({ providers: { 'github-copilot': {} } }),
      models: async () => ['gpt-4.1'],
    })
    expect(status).toEqual({
      flowAvailable: true, loggedIn: true, profileActivated: true, inFlight: false, models: ['gpt-4.1'],
    })
  })

  it('reports logged-out for an absent record', async () => {
    const status = await joinStatus({
      listFlows: () => [entry('llm-pi-ai', 'github-copilot')],
      describeRecord: async () => ({ configured: false }),
      settingsSection: () => undefined,
      models: async () => ['should-not-be-read'],
    })
    expect(status).toEqual({
      flowAvailable: true, loggedIn: false, profileActivated: false, inFlight: false, models: undefined,
    })
  })

  it('treats an api-key record as not a copilot login', async () => {
    const status = await joinStatus({
      listFlows: () => [entry('llm-pi-ai', 'github-copilot')],
      describeRecord: async () => ({ configured: true, kind: 'api-key' }),
      settingsSection: () => undefined,
      models: async () => undefined,
    })
    expect(status.loggedIn).toBe(false)
  })

  it('survives a missing credential store', async () => {
    const status = await joinStatus({
      listFlows: () => [entry('llm-pi-ai', 'github-copilot')],
      describeRecord: async () => undefined,
      settingsSection: () => undefined,
      models: async () => undefined,
    })
    expect(status.flowAvailable).toBe(true)
    expect(status.loggedIn).toBe(false)
  })

  it('reports unsupported without the flow, skipping the record read', async () => {
    let reads = 0
    const status = await joinStatus({
      listFlows: () => [],
      describeRecord: async () => {
        reads += 1
        return { configured: true, kind: 'grant' }
      },
      settingsSection: () => ({ providers: { 'github-copilot': {} } }),
      models: async () => {
        reads += 1
        return undefined
      },
    })
    expect(status).toEqual({
      flowAvailable: false, loggedIn: false, profileActivated: true, inFlight: false, models: undefined,
    })
    expect(reads).toBe(0)
  })

  it('carries in-flight and tolerates non-object providers', async () => {
    const status = await joinStatus({
      listFlows: () => [entry('llm-pi-ai', 'github-copilot', true)],
      describeRecord: async () => ({ configured: true, kind: 'grant' }),
      settingsSection: () => ({ providers: 'nope' }),
      models: async () => undefined,
    })
    expect(status.inFlight).toBe(true)
    expect(status.profileActivated).toBe(false)
  })
})
