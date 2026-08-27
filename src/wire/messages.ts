/**
 * `/v1/messages` wire protocol (the Anthropic-compatible shim Copilot serves
 * for Claude-family models): serialize harness messages into the Anthropic
 * messages shape and translate the SSE event stream into harness
 * StreamChunks. Reasoning arrives as `thinking` blocks; tool calls as
 * `tool_use` blocks whose streamed `input_json_delta` fragments assemble
 * into the raw JSON argument string the harness expects.
 *
 * @module @huanlin/dsh-plugin-copilot/wire/messages
 */

import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { FALLBACK_MAX_OUTPUT_TOKENS } from '../config.ts'
import type { CopilotModel } from '../copilot-models.ts'
import { mapAnthropicUsage, parseJsonPayload } from './shared.ts'
import type { AnthropicUsage, SseEvent } from './shared.ts'
import type { ImageResolutionOptions } from './chat.ts'

type WireContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: WireContent[]; is_error?: boolean }

interface WireMessage {
  role: 'user' | 'assistant'
  content: WireContent[]
}

/** `/v1/messages` request body (Anthropic shim; `max_tokens` is required). */
export interface WireMessagesRequest {
  model: string
  max_tokens: number
  messages: WireMessage[]
  stream: true
  system?: string
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[]
  temperature?: number
  stop_sequences?: string[]
  thinking?: { type: 'enabled'; budget_tokens: number }
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject image content in roles the Anthropic shim cannot carry it. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The Copilot messages protocol cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Parse a stored tool-call argument string into the object Anthropic expects. */
function parseToolInput(argumentsRaw: string): Record<string, unknown> {
  if (argumentsRaw.length === 0) return {}
  try {
    const value = JSON.parse(argumentsRaw) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : { value }
  } catch {
    // A malformed stored argument still has to round-trip; degrade to a wrapped string.
    return { raw: argumentsRaw }
  }
}

/** Convert user text/image blocks into ordered wire content. */
async function userParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireContent[]> {
  const parts: WireContent[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (attachments === undefined) {
          throw new LlmError('Copilot image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
        }
        const stored = await attachments.readImage(block.attachment, signal)
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
          },
        })
        break
      }
      default:
        break
    }
  }
  return parts
}

/**
 * Serialize the conversation. In-history system text merges into the
 * top-level `system` (Anthropic reserves the role); tool results ride inside
 * user messages as `tool_result` blocks, images nested under them included.
 */
async function serializeConversation(
  messages: readonly Message[],
  images: ImageResolutionOptions | undefined,
): Promise<{ system?: string; messages: WireMessage[] }> {
  assertSupportedImageRoles(messages)
  const attachments = images?.attachments
  const signal = images?.signal ?? new AbortController().signal
  const wire: WireMessage[] = []
  const systemParts: string[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (message.role === 'assistant') {
      const content: WireContent[] = []
      const text = flattenText(message.content)
      if (text.length > 0) content.push({ type: 'text', text })
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) })
        }
      }
      if (content.length > 0) wire.push({ role: 'assistant', content })
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const parts = await userParts(regular, attachments, signal)
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const nested = await userParts(block.content, attachments, signal)
      const resultContent: WireContent[] = nested.length > 0
        ? nested
        : [{ type: 'text', text: '(no output)' }]
      parts.push({
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: resultContent,
        ...block.isError === true ? { is_error: true } : {},
      })
    }
    if (parts.length > 0) wire.push({ role: 'user', content: parts })
  }
  return {
    ...systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {},
    messages: wire,
  }
}

/** Thinking budget for one effort id, or `undefined` when thinking stays off. */
export function thinkingBudgetOf(
  model: CopilotModel | undefined,
  effort: string | undefined,
): number | undefined {
  if (model?.thinkingBudgets === undefined) return undefined
  if (effort === undefined || effort === 'off') return undefined
  const budget = model.thinkingBudgets[effort as keyof typeof model.thinkingBudgets]
  // Anthropic requires budget_tokens >= 1024 and < max_tokens; a tiny ceiling means no thinking.
  return typeof budget === 'number' && budget >= 1024 ? budget : undefined
}

/** Build the full `/v1/messages` request. `max_tokens` is mandatory here (even for gpt ids). */
export async function serializeMessagesRequest(
  options: GenerateOptions,
  model: CopilotModel | undefined,
  images?: ImageResolutionOptions,
): Promise<WireMessagesRequest> {
  const requestMessages = images === undefined
    ? options.messages
    : offloadRequestImages(options.messages, images.maxImageBytes)
  const conversation = await serializeConversation(requestMessages, images)
  const tools = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  const baseMaxTokens = options.maxTokens ?? model?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS
  const budget = thinkingBudgetOf(model, options.reasoningEffort)
  const maxTokens = budget !== undefined ? Math.max(baseMaxTokens, budget + 1) : baseMaxTokens
  const system = [options.system, conversation.system]
    .filter(part => part !== undefined && part.length > 0)
    .join('\n\n')
  return {
    model: options.model,
    max_tokens: maxTokens,
    messages: conversation.messages,
    stream: true,
    ...system.length > 0 ? { system } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.stop !== undefined ? { stop_sequences: options.stop } : {},
    ...budget !== undefined ? { thinking: { type: 'enabled' as const, budget_tokens: budget } } : {},
  }
}

/** One open block under assembly, keyed by the provider content-block index. */
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

interface MessagesEvent {
  type?: string
  index?: number
  content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  message?: {
    usage?: Parameters<typeof mapAnthropicUsage>[0]
    stop_reason?: string
  }
  usage?: Parameters<typeof mapAnthropicUsage>[0]
  error?: { type?: string; message?: string }
}

/** Map the Anthropic stop_reason vocabulary to the harness FinishReason. */
export function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Consume SSE events (terminated by `message_stop`) and yield StreamChunks
 * with the shared buffering discipline. `error` events abort with
 * `LlmError`; EOF before `message_stop` is `STREAM_CLOSED`.
 */
export async function* translateMessages(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const blocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  const startUsage: AnthropicUsage = {}
  let pendingStopReason: string | undefined

  function* openFor(key: number, kind: OpenBlock['kind']): Generator<StreamChunk, OpenBlock> {
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
    const parsed = parseJsonPayload<MessagesEvent>(event.data)
    const type = parsed.type ?? event.event

    if (type === 'message_start') {
      if (parsed.message?.usage !== undefined) Object.assign(startUsage, parsed.message.usage)
      continue
    }
    if (type === 'content_block_start') {
      const block = parsed.content_block
      const key = parsed.index ?? 0
      if (block?.type === 'text') {
        yield* openFor(key, 'text')
      } else if (block?.type === 'thinking') {
        yield* openFor(key, 'reasoning')
      } else if (block?.type === 'tool_use') {
        const wire = yield* openFor(key, 'tool-call')
        wire.callId = block.id
        wire.name = block.name
      }
      continue
    }
    if (type === 'content_block_delta') {
      const key = parsed.index ?? 0
      const delta = parsed.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        const block = yield* openFor(key, 'text')
        block.text += delta.text
        yield { type: 'text-delta', index: block.index, text: delta.text }
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        const block = yield* openFor(key, 'reasoning')
        block.text += delta.thinking
        yield { type: 'reasoning-delta', index: block.index, text: delta.thinking }
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = yield* openFor(key, 'tool-call')
        if (delta.partial_json.length > 0) {
          block.text += delta.partial_json
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...block.name !== undefined ? { name: block.name } : {},
            argumentsDelta: delta.partial_json,
          }
        }
      }
      continue
    }
    if (type === 'message_delta') {
      if (typeof parsed.delta?.stop_reason === 'string') pendingStopReason = parsed.delta.stop_reason
      if (parsed.usage !== undefined) Object.assign(startUsage, parsed.usage)
      continue
    }
    if (type === 'message_stop') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      const usage = mapAnthropicUsage(startUsage)
      if (usage.inputTokens !== 0 || usage.outputTokens !== 0
        || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
        yield { type: 'usage', usage }
      }
      const reason = pendingStopReason === undefined ? { kind: 'stop' as const } : mapStopReason(pendingStopReason)
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
      throw new LlmError(
        parsed.error?.message ?? 'Copilot messages stream reported an error',
        'SERVER',
      )
    }
  }

  throw new LlmError('Copilot messages stream ended without message_stop', 'STREAM_CLOSED')
}
