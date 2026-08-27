/** Header and config unit tests: the opencode-parity request headers and connection resolution. */

import { describe, expect, it } from 'vitest'
import { initiatorOf, requestHeaders } from '../src/headers.ts'
import {
  copilotBaseUrl,
  normalizeEnterpriseDomain,
  resolveConnection,
  OAUTH_CLIENT_ID,
  COPILOT_API_VERSION,
  DEFAULT_TOKEN_ENV,
  PUBLIC_COPILOT_BASE_URL,
} from '../src/config.ts'
import { msg } from './helpers.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'github-copilot',
    model: 'gpt-5.1',
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    ...overrides,
  }
}

describe('initiator heuristic (opencode parity)', () => {
  it('marks an ordinary user prompt as user-initiated', () => {
    expect(initiatorOf(options())).toBe('user')
  })
  it('marks tool-continuation turns (tool-result-only trailing user message) as agent', () => {
    expect(initiatorOf(options({
      messages: [msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }])],
    }))).toBe('agent')
    expect(initiatorOf(options({
      messages: [msg('user', [
        { type: 'text', text: 'and now?' },
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] },
      ])],
    }))).toBe('user')
  })
  it('marks auxiliary purposes as agent', () => {
    expect(initiatorOf(options({ purpose: 'compaction' }))).toBe('agent')
    expect(initiatorOf(options({ purpose: 'session-title' }))).toBe('agent')
  })
})

describe('request headers', () => {
  const connection = resolveConnection({})
  it('carries the opencode header set', () => {
    const headers = requestHeaders(connection, {
      token: 'gho_t',
      endpoint: 'chat',
      vision: false,
      initiator: 'user',
    })
    expect(headers.authorization).toBe('Bearer gho_t')
    expect(headers['x-github-api-version']).toBe(COPILOT_API_VERSION)
    expect(headers['openai-intent']).toBe('conversation-edits')
    expect(headers['x-initiator']).toBe('user')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['accept']).toBe('text/event-stream')
    expect(headers['user-agent']).toBeDefined()
  })
  it('opts into vision and tags session-title requests', () => {
    const headers = requestHeaders(connection, {
      token: 'gho_t',
      endpoint: 'chat',
      vision: true,
      initiator: 'agent',
      purpose: 'session-title',
    })
    expect(headers['copilot-vision-request']).toBe('true')
    expect(headers['x-interaction-type']).toBe('agent-session-name-generation')
  })
  it('adds the Anthropic-shim headers only on the messages endpoint', () => {
    const messages = requestHeaders(connection, { token: 't', endpoint: 'messages', vision: false, initiator: 'user' })
    expect(messages['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
    expect(messages['anthropic-version']).toBe('2023-06-01')
    const chat = requestHeaders(connection, { token: 't', endpoint: 'chat', vision: false, initiator: 'user' })
    expect(chat['anthropic-beta']).toBeUndefined()
  })
})

describe('connection resolution', () => {
  it('applies the opencode defaults', () => {
    const connection = resolveConnection({})
    expect(connection.clientId).toBe(OAUTH_CLIENT_ID)
    expect(connection.apiVersion).toBe(COPILOT_API_VERSION)
    expect(connection.githubTokenEnv).toBe(DEFAULT_TOKEN_ENV)
    expect(connection.enterpriseDomain).toBeUndefined()
    expect(connection.retryPolicy).toBeDefined()
    expect(connection.authFile).toContain('github-copilot-auth.json')
  })

  it('normalizes enterprise URLs the way opencode does', () => {
    expect(normalizeEnterpriseDomain('https://company.ghe.com/')).toBe('company.ghe.com')
    expect(normalizeEnterpriseDomain('company.ghe.com')).toBe('company.ghe.com')
    expect(resolveConnection({ enterpriseUrl: 'https://company.ghe.com/' }).enterpriseDomain).toBe('company.ghe.com')
  })

  it('derives the API base per deployment', () => {
    expect(copilotBaseUrl(undefined, undefined)).toBe(PUBLIC_COPILOT_BASE_URL)
    expect(copilotBaseUrl(undefined, 'company.ghe.com')).toBe('https://copilot-api.company.ghe.com')
    expect(copilotBaseUrl('https://proxy.example/v1', 'company.ghe.com')).toBe('https://proxy.example/v1')
  })

  it('rejects out-of-bound numbers and malformed URLs', () => {
    expect(() => resolveConnection({ modelsRefreshMs: 10 })).toThrow(/modelsRefreshMs/)
    expect(() => resolveConnection({ streamIdleTimeoutMs: -1 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveConnection({ baseURL: 'not a url' })).toThrow(/baseURL/)
    expect(() => resolveConnection({ clientId: '' })).toThrow(/clientId/)
  })
})
