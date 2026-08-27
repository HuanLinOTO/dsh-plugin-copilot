/** Messages-shim (Anthropic) wire tests: serialization, thinking budgets, event translation. */

import { describe, expect, it } from 'vitest'
import { serializeMessagesRequest, translateMessages, mapStopReason, thinkingBudgetOf } from '../src/wire/messages.ts'
import { collect, msg, ssePairs } from './helpers.ts'
import type { CopilotModel } from '../src/copilot-models.ts'

function claudeModel(): CopilotModel {
  return {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    family: 'claude',
    endpoint: 'messages',
    pickerEnabled: true,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsVision: true,
    supportsPdf: true,
    thinkingBudgets: { low: 2_048, high: 4_096, max: 8_191 },
  }
}

const baseOptions = {
  provider: 'github-copilot',
  model: 'claude-sonnet-4',
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
} as const

describe('messages serialization', () => {
  it('maps system to the top-level field and merges in-history system text', async () => {
    const request = await serializeMessagesRequest({
      ...baseOptions,
      system: 'be brief',
      messages: [
        msg('system', [{ type: 'text', text: 'workspace rules' }]),
        msg('user', [{ type: 'text', text: 'hi' }]),
      ],
    }, undefined)
    expect(request.system).toBe('be brief\n\nworkspace rules')
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(request.max_tokens).toBe(16_384)
  })

  it('replays assistant tool_use with parsed input and tool_result blocks', async () => {
    const request = await serializeMessagesRequest({
      ...baseOptions,
      messages: [
        msg('user', [{ type: 'text', text: 'list files' }]),
        msg('assistant', [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', id: 'tu_1', name: 'ls', arguments: '{"path":"."}' },
        ]),
        msg('user', [
          { type: 'tool-result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'a.txt' }], isError: true },
        ]),
      ],
    }, undefined)
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tu_1', name: 'ls', input: { path: '.' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'a.txt' }], is_error: true },
      ] },
    ])
  })

  it('always sends max_tokens and raises it above the thinking budget', async () => {
    const request = await serializeMessagesRequest({
      ...baseOptions,
      maxTokens: 4_096,
      reasoningEffort: 'max',
    }, claudeModel())
    // Anthropic requires max_tokens > budget_tokens, so 4096 is raised to 8192.
    expect(request.max_tokens).toBe(8_192)
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 8_191 })
  })

  it('skips thinking for off effort and for non-budget models', async () => {
    const off = await serializeMessagesRequest({ ...baseOptions, reasoningEffort: 'off' }, claudeModel())
    expect(off.thinking).toBeUndefined()
    const plain = await serializeMessagesRequest({ ...baseOptions, reasoningEffort: 'high' }, { ...claudeModel(), thinkingBudgets: undefined })
    expect(plain.thinking).toBeUndefined()
  })

  it('derives budgets with the same thresholds the model mapping produced', () => {
    expect(thinkingBudgetOf(claudeModel(), 'high')).toBe(4_096)
    expect(thinkingBudgetOf(claudeModel(), 'off')).toBeUndefined()
    expect(thinkingBudgetOf(undefined, 'high')).toBeUndefined()
  })

  it('carries stop sequences, temperature, and tools', async () => {
    const request = await serializeMessagesRequest({
      ...baseOptions,
      stop: ['END'],
      temperature: 0.1,
      tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }],
    }, undefined)
    expect(request.stop_sequences).toEqual(['END'])
    expect(request.temperature).toBe(0.1)
    expect(request.tools).toEqual([{ name: 'ls', description: 'list', input_schema: { type: 'object' } }])
  })
})

describe('messages translation', () => {
  it('assembles text/thinking/tool_use blocks and merges both usage reports', async () => {
    const chunks = await collect(translateMessages(ssePairs([
      ['message_start', JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } })],
      ['content_block_start', JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })],
      ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ponder' } })],
      ['content_block_start', JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })],
      ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } })],
      ['content_block_start', JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'ls' } })],
      ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } })],
      ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"."}' } })],
      ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 2 })],
      ['message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })],
      ['message_stop', JSON.stringify({ type: 'message_stop' })],
    ])))
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(3)
    const ends = chunks.filter(chunk => chunk.type === 'block-end') as { block: { type: string; arguments?: string; id?: string } }[]
    expect(ends.map(end => end.block.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(ends[2]?.block).toMatchObject({ id: 'tu_1', name: 'ls', arguments: '{"path":"."}' })
    const usage = chunks.find(chunk => chunk.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
    expect(usage.usage).toEqual({ inputTokens: 15, outputTokens: 9, cacheReadTokens: 5 })
    expect((chunks.at(-1) as { reason: { kind: string } }).reason).toEqual({ kind: 'tool-calls' })
  })

  it('maps stop reasons and flags empty completions', async () => {
    expect(mapStopReason('end_turn')).toEqual({ kind: 'stop' })
    expect(mapStopReason('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(mapStopReason('model_context_window_exceeded').kind).toBe('error')

    const chunks = await collect(translateMessages(ssePairs([
      ['message_start', JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })],
      ['message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })],
      ['message_stop', JSON.stringify({ type: 'message_stop' })],
    ])))
    const finish = chunks.at(-1) as { reason: { kind: string; failure?: { code: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('EMPTY_RESPONSE')
  })

  it('throws on error events and on EOF without message_stop', async () => {
    await expect(collect(translateMessages(ssePairs([
      ['error', JSON.stringify({ type: 'error', error: { message: 'overloaded' } })],
    ])))).rejects.toMatchObject({ code: 'SERVER' })
    await expect(collect(translateMessages(ssePairs([
      ['message_start', JSON.stringify({ type: 'message_start', message: { usage: {} } })],
    ])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
