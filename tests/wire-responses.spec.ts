/** Responses-API wire tests: input item serialization and event translation. */

import { describe, expect, it } from 'vitest'
import { serializeResponsesRequest, translateResponses } from '../src/wire/responses.ts'
import { collect, msg, ssePairs } from './helpers.ts'

const baseOptions = {
  provider: 'github-copilot',
  model: 'gpt-5.1',
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
} as const

describe('responses serialization', () => {
  it('maps system to instructions, tools to flattened function tools', async () => {
    const request = await serializeResponsesRequest({
      ...baseOptions,
      system: 'be brief',
      maxTokens: 1_000,
      tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }],
    }, undefined)
    expect(request.instructions).toBe('be brief')
    expect(request.tools).toEqual([{
      type: 'function', name: 'ls', description: 'list', parameters: { type: 'object' }, strict: false,
    }])
    // gpt models omit the output cap (opencode parity).
    expect(request.max_output_tokens).toBeUndefined()
    expect(request.stream).toBe(true)
  })

  it('keeps max_output_tokens for non-gpt models and carries effort when supported', async () => {
    const model = {
      id: 'other-model', name: 'Other', endpoint: 'responses' as const, pickerEnabled: true,
      supportsVision: false, supportsPdf: false, reasoningEfforts: ['low', 'high'],
    }
    const request = await serializeResponsesRequest({
      ...baseOptions,
      model: 'other-model',
      maxTokens: 2_000,
      reasoningEffort: 'high',
    }, model)
    expect(request.max_output_tokens).toBe(2_000)
    expect(request.reasoning).toEqual({ effort: 'high' })
  })

  it('serializes assistant tool calls and tool results as stateless items', async () => {
    const request = await serializeResponsesRequest({
      ...baseOptions,
      messages: [
        msg('user', [{ type: 'text', text: 'list files' }]),
        msg('assistant', [
          { type: 'tool-call', id: 'call_1', name: 'ls', arguments: '{"path":"."}' },
        ]),
        msg('user', [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
        ]),
      ],
    }, undefined)
    expect(request.input).toEqual([
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{"path":"."}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ])
  })
})

describe('responses translation', () => {
  const COMPLETED = (usage: object) => JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', usage },
  })

  it('streams text, reasoning, and function-call arguments; buffers the ends', async () => {
    const chunks = await collect(translateResponses(ssePairs([
      ['response.output_item.added', JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } })],
      ['response.reasoning_summary_text.delta', JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' })],
      ['response.output_item.added', JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg1' } })],
      ['response.output_text.delta', JSON.stringify({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Hi' })],
      ['response.completed', COMPLETED({ input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } })],
    ])))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.find(chunk => chunk.type === 'reasoning-delta')).toMatchObject({ text: 'plan' })
    expect(chunks.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'Hi' })
    const usage = chunks.find(chunk => chunk.type === 'usage') as { usage: { inputTokens: number; reasoningTokens?: number; cacheReadTokens?: number } }
    expect(usage.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 })
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason).toEqual({ kind: 'stop' })
  })

  it('emits tool-call chunks and a tool-calls finish', async () => {
    const chunks = await collect(translateResponses(ssePairs([
      ['response.output_item.added', JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'ls' } })],
      ['response.function_call_arguments.delta', JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path"' })],
      ['response.function_call_arguments.delta', JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"."}' })],
      ['response.completed', COMPLETED({ input_tokens: 1, output_tokens: 1 })],
    ])))
    expect(chunks[0]).toMatchObject({ type: 'block-start', blockType: 'tool-call' })
    const end = chunks.find(chunk => chunk.type === 'block-end') as { block: { type: string; id: string; name: string; arguments: string } }
    expect(end.block).toEqual({ type: 'tool-call', id: 'call_1', name: 'ls', arguments: '{"path":"."}' })
    expect((chunks.at(-1) as { reason: { kind: string } }).reason).toEqual({ kind: 'tool-calls' })
  })

  it('maps incomplete max_output_tokens to a max-tokens finish', async () => {
    const chunks = await collect(translateResponses(ssePairs([
      ['response.output_text.delta', JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' })],
      ['response.incomplete', JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })],
    ])))
    expect((chunks.at(-1) as { reason: { kind: string } }).reason).toEqual({ kind: 'max-tokens' })
  })

  it('throws on response.failed and error events', async () => {
    await expect(collect(translateResponses(ssePairs([
      ['response.failed', JSON.stringify({ type: 'response.failed', response: { error: { message: 'bad request upstream' } } })],
    ])))).rejects.toMatchObject({ code: 'SERVER' })
    await expect(collect(translateResponses(ssePairs([
      ['error', JSON.stringify({ type: 'error', message: 'server exploded' })],
    ])))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('rejects EOF before a terminal event and empty completions', async () => {
    await expect(collect(translateResponses(ssePairs([
      ['response.output_text.delta', JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })],
    ])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    const chunks = await collect(translateResponses(ssePairs([
      ['response.completed', COMPLETED({ input_tokens: 0, output_tokens: 0 })],
    ])))
    expect((chunks.at(-1) as { reason: { kind: string; failure: { code: string } } }).reason.failure.code).toBe('EMPTY_RESPONSE')
  })
})
