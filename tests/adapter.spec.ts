/** Adapter integration tests: auth resolution → endpoint routing → headers → SSE → StreamChunks. */

import { describe, expect, it, vi } from 'vitest'
import { CopilotAdapter } from '../src/adapter.ts'
import { resolveConnection } from '../src/config.ts'
import { buildModel } from '../src/copilot-models.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { collect, msg } from './helpers.ts'

const CONNECTION = resolveConnection({ authFile: '/tmp/does-not-matter.json' })

const AUTH = {
  token: 'gho_integration',
  source: 'device-flow' as const,
}

/** Build an SSE response body from data payload lines. */
function sseResponse(payloads: readonly string[]): Response {
  const text = payloads.map(payload => `data: ${payload}\n\n`).join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function adapterWith(
  fetchImpl: typeof fetch,
  opts: { auth?: typeof AUTH } = {},
): CopilotAdapter {
  // Absent `auth` key means "logged in" (the test default); an explicit
  // undefined means no credential anywhere.
  const auth = 'auth' in opts ? opts.auth : AUTH
  return new CopilotAdapter({
    options: () => CONNECTION,
    resolveAuth: async () => {
      if (auth === undefined) throw new LlmError('no token anywhere', 'MISSING_CREDENTIAL')
      return auth
    },
    resolveAttachments: () => undefined,
    fetchImpl,
  })
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'github-copilot',
    model: 'gpt-5.1',
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    ...overrides,
  }
}

describe('CopilotAdapter', () => {
  it('routes uncached gpt-5 models to /responses with the opencode header set', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hey' }),
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } },
      }),
    ]))
    const adapter = adapterWith(fetchMock as unknown as typeof fetch)
    const chunks = await collect(adapter.stream(options()))
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/responses')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer gho_integration')
    expect(headers['x-initiator']).toBe('user')
    expect(headers['x-github-api-version']).toBe(CONNECTION.apiVersion)
    const body = JSON.parse(init.body as string)
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }])
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason).toEqual({ kind: 'stop' })
  })

  it('uses the cached catalog endpoint (messages shim) for known claude models', async () => {
    const catalog = {
      data: [{
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        model_picker_enabled: true,
        supported_endpoints: ['/v1/messages', '/chat/completions'],
        policy: { state: 'enabled' },
        capabilities: {
          family: 'claude',
          limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000, max_prompt_tokens: 1 },
          supports: { tool_calls: true },
        },
      }],
    }
    const responses: Response[] = [
      new Response(JSON.stringify(catalog), { status: 200 }),
      sseResponse([
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bonjour' } }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    ]
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    const adapter = adapterWith(fetchMock as unknown as typeof fetch)

    // Warm the catalog (also proves the /models request carries the bearer).
    const models = await adapter.listModels('github-copilot')
    expect(models.map(model => model.id)).toEqual(['claude-sonnet-4'])
    const [modelsUrl, modelsInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(modelsUrl).toBe('https://api.githubcopilot.com/models')
    expect((modelsInit.headers as Record<string, string>).authorization).toBe('Bearer gho_integration')

    const chunks = await collect(adapter.stream(options({ model: 'claude-sonnet-4' })))
    const [url] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect((chunks.find(chunk => chunk.type === 'text-delta') as { text: string }).text).toBe('bonjour')
  })

  it('falls back to the static catalog when the models endpoint fails', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    const adapter = adapterWith(fetchMock as unknown as typeof fetch)
    const models = await adapter.listModels('github-copilot')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === 'github-copilot')).toBe(true)
  })

  it('normalizes missing credentials to a MISSING_CREDENTIAL LlmError', async () => {
    const adapter = adapterWith(vi.fn(), { auth: undefined })
    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })
  })

  it('marks tool-continuation turns as agent-initiated', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }, { finish_reason: 'stop' }], usage: {} }),
      '[DONE]',
    ]))
    const adapter = adapterWith(fetchMock as unknown as typeof fetch)
    // o4-mini has no catalog entry and is not gpt-5 class, so it routes to chat completions.
    await collect(adapter.stream(options({
      model: 'o4-mini',
      messages: [msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }])],
    })))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-initiator']).toBe('agent')
  })
})

/** Guard: the catalog model build still routes messages-shim models correctly (adapter-level dependency). */
describe('catalog routing dependency', () => {
  it('keeps /v1/messages priority for claude models', () => {
    const model = buildModel({
      id: 'claude-sonnet-4',
      supported_endpoints: ['/v1/messages', '/chat/completions'],
      capabilities: {
        family: 'claude',
        limits: { max_output_tokens: 32_000, max_prompt_tokens: 1 },
        supports: { tool_calls: true },
      },
    })
    expect(model.endpoint).toBe('messages')
  })
})
