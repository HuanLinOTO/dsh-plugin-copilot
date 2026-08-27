/** Chat-completions wire tests: request serialization and stream translation. */

import { describe, expect, it } from 'vitest'
import { serializeChatRequest, translateChat, mapFinishReason, omitsMaxTokens } from '../src/wire/chat.ts'
import { collect, msg, sseEvents } from './helpers.ts'
import type { CopilotModel } from '../src/copilot-models.ts'

function chatModel(overrides: Partial<CopilotModel> = {}): CopilotModel {
  return {
    id: 'gpt-5.1',
    name: 'GPT 5.1',
    endpoint: 'chat',
    pickerEnabled: true,
    contextWindow: 400_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsPdf: false,
    ...overrides,
  }
}

const baseOptions = {
  provider: 'github-copilot',
  model: 'gpt-5.1',
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
} as const

describe('chat serialization', () => {
  it('maps system, user, assistant, and tool-result messages', async () => {
    const request = await serializeChatRequest({
      ...baseOptions,
      system: 'sys',
      messages: [
        msg('user', [{ type: 'text', text: 'list files' }]),
        msg('assistant', [
          { type: 'text', text: '' },
          { type: 'tool-call', id: 'call_1', name: 'ls', arguments: '{"path":"."}' },
        ]),
        msg('user', [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
        ]),
      ],
    }, undefined)
    expect(request.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    ])
  })

  it('omits max_tokens for gpt-family models (Copilot CLI parity)', async () => {
    const request = await serializeChatRequest({ ...baseOptions, maxTokens: 4_096 }, undefined)
    expect(request.max_tokens).toBeUndefined()
    expect(omitsMaxTokens('gpt-5.1')).toBe(true)
    expect(omitsMaxTokens('claude-sonnet-4')).toBe(false)
  })

  it('keeps max_tokens for non-gpt models', async () => {
    const request = await serializeChatRequest({
      ...baseOptions,
      model: 'claude-sonnet-4',
      maxTokens: 4_096,
    }, undefined)
    expect(request.max_tokens).toBe(4_096)
  })

  it('carries effort only when the model supports it and it is not off', async () => {
    const model = chatModel({ reasoningEfforts: ['low', 'high'] })
    const withEffort = await serializeChatRequest({ ...baseOptions, reasoningEffort: 'high' }, model)
    expect(withEffort.reasoning_effort).toBe('high')
    const offEffort = await serializeChatRequest({ ...baseOptions, reasoningEffort: 'off' }, model)
    expect(offEffort.reasoning_effort).toBeUndefined()
    const unsupported = await serializeChatRequest({ ...baseOptions, reasoningEffort: 'high' }, chatModel())
    expect(unsupported.reasoning_effort).toBeUndefined()
  })

  it('serializes tools, temperature, and stop', async () => {
    const request = await serializeChatRequest({
      ...baseOptions,
      temperature: 0.2,
      stop: ['END'],
      tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }],
    }, undefined)
    expect(request.tools).toEqual([{
      type: 'function',
      function: { name: 'ls', description: 'list', parameters: { type: 'object' } },
    }])
    expect(request.temperature).toBe(0.2)
    expect(request.stop).toEqual(['END'])
    expect(request.stream).toBe(true)
    expect(request.stream_options).toEqual({ include_usage: true })
  })

  it('converts images to data-URL parts and tool-result images to a user message', async () => {
    const attachments = {
      readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }),
    }
    const imageBlock = {
      type: 'image',
      attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
    }
    const request = await serializeChatRequest({
      ...baseOptions,
      model: 'gpt-4o',
      messages: [
        msg('user', [imageBlock as never]),
        msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [imageBlock as never] }]),
      ],
    }, chatModel({ id: 'gpt-4o' }), { attachments: attachments as never, signal: new AbortController().signal, maxImageBytes: 1_000 })
    const [imageMsg, toolMsg, tailMsg] = request.messages
    expect((imageMsg.content as { type: string }[])[0]?.type).toBe('image_url')
    expect((toolMsg as { content: string }).content).toBe('(see attached image)')
    expect((tailMsg.content as { type: string }[])[0]?.type).toBe('text')
    expect((tailMsg.content as { type: string }[])[1]?.type).toBe('image_url')
  })
})

describe('chat translation', () => {
  it('streams deltas and buffers block-end/usage/finish until [DONE]', async () => {
    const chunks = await collect(translateChat(sseEvents([
      JSON.stringify({ choices: [{ delta: { content: 'He' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'llo' } }] }),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
      }),
      '[DONE]',
    ])))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason).toEqual({ kind: 'stop' })
    const usage = chunks.find(chunk => chunk.type === 'usage') as { usage: { inputTokens: number; cacheReadTokens?: number } }
    expect(usage.usage).toEqual({ inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 })
  })

  it('assembles streamed tool calls with raw JSON arguments', async () => {
    const chunks = await collect(translateChat(sseEvents([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'ls', arguments: '{"p' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":"."}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])))
    const end = chunks.find(chunk => chunk.type === 'block-end') as { index: number; block: { type: string; id: string; name: string; arguments: string } }
    expect(end.block).toEqual({ type: 'tool-call', id: 'call_9', name: 'ls', arguments: '{"path":"."}' })
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
  })

  it('streams reasoning deltas before text', async () => {
    const chunks = await collect(translateChat(sseEvents([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'act' } }] }),
      '[DONE]',
    ])))
    expect(chunks[0]).toMatchObject({ type: 'block-start', blockType: 'reasoning' })
    expect(chunks[1]).toMatchObject({ type: 'reasoning-delta', text: 'think' })
    expect(chunks[2]).toMatchObject({ type: 'block-start', blockType: 'text' })
  })

  it('maps an empty stop to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await collect(translateChat(sseEvents([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])))
    const finish = chunks.at(-1) as { reason: { kind: string; failure: { code: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure.code).toBe('EMPTY_RESPONSE')
  })

  it('aborts on malformed payloads and on EOF without [DONE]', async () => {
    await expect(collect(translateChat(sseEvents(['{broken'])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect(translateChat(sseEvents([JSON.stringify({ choices: [] })])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('maps unknown finish reasons to error finishes', () => {
    expect(mapFinishReason('content_filter').kind).toBe('error')
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })
})
