/**
 * `/responses` wire protocol (OpenAI Responses API, as shimmed by Copilot for
 * GPT-5 class models): serialize harness messages into stateless input items
 * and translate the event stream into harness StreamChunks. Reasoning
 * summaries stream into reasoning blocks; function calls stream their
 * arguments as raw JSON fragments. Encrypted-reasoning replay is out of
 * scope (the harness conversation vocabulary keeps reasoning as text), which
 * matches a stateless, store-free request.
 *
 * @module @huanlin/dsh-plugin-copilot/wire/responses
 */

import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CopilotModel } from '../copilot-models.ts'
import { mapResponsesUsage, parseJsonPayload } from './shared.ts'
import type { SseEvent } from './shared.ts'
import type { ImageResolutionOptions } from './chat.ts'

type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

type InputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string | InputPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** `/responses` request body (always streaming, fully stateless input). */
export interface WireResponsesRequest {
  model: string
  input: InputItem[]
  stream: true
  instructions?: string
  tools?: {
    type: 'function'
    name: string
    description: string
    parameters: Record<string, unknown>
    strict: false
  }[]
  temperature?: number
  max_output_tokens?: number
  reasoning?: { effort: string }
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject image content in roles whose Responses item cannot carry it. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The Copilot responses protocol cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Convert user text/image blocks into ordered input parts. */
async function userParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<InputPart[]> {
  const parts: InputPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
        break
      case 'image': {
        if (attachments === undefined) {
          throw new LlmError('Copilot image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
        }
        const stored = await attachments.readImage(block.attachment, signal)
        parts.push({
          type: 'input_image',
          image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
        })
        break
      }
      default:
        break
    }
  }
  return parts
}

/** Serialize the conversation into Responses input items. */
async function serializeInput(
  messages: readonly Message[],
  images: ImageResolutionOptions | undefined,
): Promise<InputItem[]> {
  assertSupportedImageRoles(messages)
  const attachments = images?.attachments
  const signal = images?.signal ?? new AbortController().signal
  const items: InputItem[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) items.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      if (text.length > 0) items.push({ role: 'assistant', content: text })
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
        }
      }
      continue
    }

    // user: text/images first, then tool results as function_call_output items.
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const parts = await userParts(regular, attachments, signal)
    if (parts.length > 0) {
      items.push({
        role: 'user',
        content: parts.every(part => part.type === 'input_text') && parts.length === 1
          ? (parts[0] as { type: 'input_text'; text: string }).text
          : parts,
      })
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      // function_call_output carries string output only; nested images degrade to a note.
      const nested = await userParts(block.content, attachments, signal)
      const text = nested.filter(part => part.type === 'input_text').map(part => part.text).join('')
      const hasImage = nested.some(part => part.type === 'input_image')
      items.push({
        type: 'function_call_output',
        call_id: block.toolCallId,
        output: text || (hasImage ? '(image output not supported here)' : '(no output)'),
      })
    }
  }
  return items
}

/** Build the full `/responses` request. gpt-family models omit the output cap (opencode parity). */
export async function serializeResponsesRequest(
  options: GenerateOptions,
  model: CopilotModel | undefined,
  images?: ImageResolutionOptions,
): Promise<WireResponsesRequest> {
  const requestMessages = images === undefined
    ? options.messages
    : offloadRequestImages(options.messages, images.maxImageBytes)
  const items = await serializeInput(requestMessages, images)
  const tools = options.tools?.map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false as const,
  }))
  const effort = options.reasoningEffort
  const supportsEffort = effort !== undefined
      && model?.reasoningEfforts !== undefined
      && model.reasoningEfforts.includes(effort)
  return {
    model: options.model,
    input: items,
    stream: true,
    ...options.system !== undefined ? { instructions: options.system } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.model.includes('gpt') || options.maxTokens === undefined
      ? {}
      : { max_output_tokens: options.maxTokens },
    ...supportsEffort && effort !== 'off' ? { reasoning: { effort } } : {},
  }
}

/** One open block under assembly, keyed by the provider item/output index. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

interface OutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
}

interface ResponsesEvent {
  type?: string
  item?: OutputItem
  output_index?: number
  content_index?: number
  delta?: string
  response?: {
    status?: string
    usage?: Parameters<typeof mapResponsesUsage>[0]
    incomplete_details?: { reason?: string }
    error?: { message?: string; code?: string }
  }
  message?: string
  code?: string
}

/**
 * Consume SSE events (terminated by `response.completed` / `response.incomplete`)
 * and yield StreamChunks with the same buffering discipline as the chat
 * protocol. `response.failed` and top-level `error` events abort with
 * `LlmError`; EOF before a terminal event is `STREAM_CLOSED`.
 */
export async function* translateResponses(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const blocks = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let sawToolCall = false

  // Open (or reuse) the block for `key`, emitting its block-start exactly once.
  function* openFor(key: string, kind: OpenBlock['kind']): Generator<StreamChunk, OpenBlock> {
    let block = blocks.get(key)
    if (block === undefined) {
      block = { index: nextIndex++, kind, text: '' }
      blocks.set(key, block)
      order.push(block)
      yield { type: 'block-start', index: block.index, blockType: kind }
    }
    return block
  }

  for await (const event of events) {
    const parsed = parseJsonPayload<ResponsesEvent>(event.data)
    const type = parsed.type ?? event.event

    if (type === 'response.output_item.added') {
      const item = parsed.item
      const key = String(parsed.output_index ?? item?.id ?? '')
      if (item?.type === 'function_call') {
        sawToolCall = true
        const block = yield* openFor(key, 'tool-call')
        block.callId = item.call_id
        block.name = item.name
      }
      continue
    }
    if (type === 'response.output_text.delta') {
      const delta = parsed.delta
      if (typeof delta === 'string' && delta.length > 0) {
        const block = yield* openFor(`${parsed.output_index ?? ''}:${parsed.content_index ?? ''}`, 'text')
        block.text += delta
        yield { type: 'text-delta', index: block.index, text: delta }
      }
      continue
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = parsed.delta
      if (typeof delta === 'string' && delta.length > 0) {
        const block = yield* openFor(String(parsed.output_index ?? parsed.item?.id ?? ''), 'reasoning')
        block.text += delta
        yield { type: 'reasoning-delta', index: block.index, text: delta }
      }
      continue
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = parsed.delta
      if (typeof delta === 'string' && delta.length > 0) {
        sawToolCall = true
        const block = yield* openFor(String(parsed.output_index ?? ''), 'tool-call')
        block.text += delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: delta,
        }
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = parsed.response
      if (type === 'response.failed') {
        throw new LlmError(
          response?.error?.message ?? 'Copilot responses request failed',
          'SERVER',
        )
      }
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (response?.usage !== undefined) yield { type: 'usage', usage: mapResponsesUsage(response.usage) }
      let reason: FinishReason
      if (type === 'response.incomplete') {
        reason = response?.incomplete_details?.reason === 'max_output_tokens'
          ? { kind: 'max-tokens' }
          : {
            kind: 'error',
            failure: {
              message: `response incomplete: ${response?.incomplete_details?.reason ?? 'unknown reason'}`,
              code: 'RESPONSE_INCOMPLETE',
            },
          }
      } else if (sawToolCall) {
        reason = { kind: 'tool-calls' }
      } else {
        reason = { kind: 'stop' }
      }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: {
              message: 'model returned a completed response with no content',
              code: EMPTY_RESPONSE_CODE,
            },
          }
          : reason,
      }
      return
    }
    if (type === 'error') {
      throw new LlmError(parsed.message ?? 'Copilot responses stream reported an error', 'SERVER')
    }
  }

  throw new LlmError('Copilot responses stream ended without a terminal event', 'STREAM_CLOSED')
}
