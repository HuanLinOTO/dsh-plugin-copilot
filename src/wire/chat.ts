/**
 * `/chat/completions` wire protocol: serialize harness messages into the
 * OpenAI-compatible chat completions request and translate the SSE stream
 * back into harness StreamChunks. Follows the DeepSeek adapter's streaming
 * discipline (blocks open on first delta, `block-end`/`usage`/`finish`
 * buffered to the terminator so nothing follows `finish`), with the opencode
 * Copilot quirk that gpt-family models omit the output-token cap entirely.
 *
 * @module @huanlin/dsh-plugin-copilot/wire/chat
 */

import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CopilotModel } from '../copilot-models.ts'
import { mapOpenAiUsage, parseJsonPayload } from './shared.ts'
import type { OpenAiUsage, SseEvent } from './shared.ts'

/** Dependencies required only when the request contains image input. */
export interface ImageResolutionOptions {
  /** Durable resolver for canonical image references. */
  attachments: AttachmentStore
  /** Cancellation shared with the provider request. */
  signal: AbortSignal
  /** Positive bound on accumulated base64 image payload. */
  maxImageBytes: number
}

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[]
  tool_call_id?: string
  tool_calls?: WireToolCall[]
}

/** `/chat/completions` request body (streaming always on). */
export interface WireChatRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
  reasoning_effort?: string
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before a text-flattening path can silently erase it. */
function assertTextOnly(message: Message): void {
  if (message.role !== 'user' && contentHasImage(message.content)) {
    throw new LlmError(
      `The Copilot chat-completions protocol cannot represent image content in a ${message.role} message.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Resolve one durable image into its transient data-URL part. */
async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  attachments: AttachmentStore,
  signal: AbortSignal,
): Promise<WireContentPart> {
  const stored = await attachments.readImage(block.attachment, signal)
  return {
    type: 'image_url',
    image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
  }
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireContentPart[]> {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        if (attachments === undefined) {
          throw new LlmError('Copilot image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
        }
        parts.push(await imagePart(block, attachments, signal))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, attachments, signal))
        break
      default:
        break
    }
  }
  return parts
}

/** Serialize one assistant message (text + tool calls; reasoning is not replayed). */
function serializeAssistant(message: Message): WireMessage {
  const toolCalls: WireToolCall[] = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    // Text-less turns send "" — never null; some gateways reject null outright.
    content: flattenText(message.content),
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; tool-result images follow as one user message.
 */
async function serializeMessages(
  messages: readonly Message[],
  images: ImageResolutionOptions | undefined,
): Promise<WireMessage[]> {
  const attachments = images?.attachments
  const signal = images?.signal ?? new AbortController().signal
  const wire: WireMessage[] = []
  let pendingToolImages: WireContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    assertTextOnly(message)
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const parts = await contentParts(regular, attachments, signal)
    const textOnly = parts.every(part => part.type === 'text')
    const text = parts.map(part => part.type === 'text' ? part.text : '').join('')
    if (text.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: textOnly ? text : parts })
    }
    for (const result of toolResults) {
      const resultParts = await contentParts(result.content, attachments, signal)
      const resultImages = resultParts.filter(part => part.type === 'image_url')
      const resultText = resultParts.filter(part => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: resultText || (resultImages.length > 0 ? '(see attached image)' : '(no output)'),
      })
      pendingToolImages.push(...resultImages)
    }
  }
  flushToolImages()
  return wire
}

/** Whether the gpt-family output-token omission applies (opencode parity: substring match). */
export function omitsMaxTokens(modelId: string): boolean {
  return modelId.includes('gpt')
}

/**
 * Build the full chat-completions request. Always streaming with usage
 * reporting; optional fields are omitted rather than sent as null.
 * gpt-family models never carry `max_tokens` (GitHub Copilot CLI parity).
 */
export async function serializeChatRequest(
  options: GenerateOptions,
  model: CopilotModel | undefined,
  images?: ImageResolutionOptions,
): Promise<WireChatRequest> {
  const requestMessages = images === undefined
    ? options.messages
    : offloadRequestImages(options.messages, images.maxImageBytes)
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessages(requestMessages, images))

  const tools = options.tools?.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const effort = options.reasoningEffort
  const supportsEffort = effort !== undefined
      && model?.reasoningEfforts !== undefined
      && model.reasoningEfforts.includes(effort)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...omitsMaxTokens(options.model) || options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
    ...supportsEffort && effort !== 'off' ? { reasoning_effort: effort } : {},
  }
}

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/** Assemble the final ContentBlock for one open block. */
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

interface WireChatChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: OpenAiUsage
}

/**
 * Consume SSE events (terminated by the `data: [DONE]` sentinel) and yield
 * StreamChunks. Deltas stream through as they arrive; `block-end`s, usage,
 * and finish are deferred to the sentinel, so no chunk follows `finish`. A
 * `stop` (or absent) finish with no opened blocks is a degenerate completion
 * and maps to an `EMPTY_RESPONSE` error finish.
 */
export async function* translateChat(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const { data } of events) {
    if (data === '[DONE]') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
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

    const chunk = parseJsonPayload<WireChatChunk>(data)
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: interleaved before text; an empty first delta must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        const key = call.index ?? 0
        let block = toolBlocks.get(key)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    if (chunk.usage !== undefined) {
      pendingUsage = mapOpenAiUsage(chunk.usage)
    }
  }

  // EOF before the sentinel is a truncated response; the model call cannot be trusted.
  throw new LlmError('Copilot chat stream ended without [DONE]', 'STREAM_CLOSED')
}
