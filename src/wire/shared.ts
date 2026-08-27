/**
 * Shared wire-layer plumbing for the three Copilot protocols: SSE event
 * parsing (event name + data payload, framing by `eventsource-parser`),
 * protocol termination sentinels, HTTP error mapping to stable `LlmError`
 * codes, retry-after parsing, and usage mappers for the OpenAI and Anthropic
 * usage vocabularies.
 *
 * @module @huanlin/dsh-plugin-copilot/wire/shared
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One decoded SSE event: the (possibly empty) event name and its data payload. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * Parse an SSE byte stream into `{event, data}` events. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment skipping, multi-`data:`
 * joining — is `eventsource-parser`'s. Comments and activity pulses go to the
 * optional callback. Unlike the DeepSeek adapter's data-only parser, the
 * three Copilot protocols have different terminators, so the raw events are
 * yielded and each protocol's translate owns its terminal check.
 */
export async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SseEvent> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment: onActivity === undefined ? undefined : () => onActivity() }))
  for await (const chunk of events) {
    // eventsource-parser v3 omits `event` when the sender used the default
    // "message" event name; normalize so consumers always see both fields.
    if (chunk.data === undefined) continue // comment payloads carry no data
    onActivity?.()
    yield { event: chunk.event ?? 'message', data: chunk.data }
  }
}

/** Parse one event's JSON payload; malformed JSON aborts with `MALFORMED_RESPONSE`. */
export function parseJsonPayload<T>(payload: string): T {
  try {
    return JSON.parse(payload) as T
  } catch {
    throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }
}

/** Parsed provider error body; both OpenAI (`error.message`) and Anthropic (`error.type/message`) shapes. */
export interface WireErrorBody {
  message?: string
  detail: string
}

/** Best-effort parse of a non-2xx body; a malformed gateway body keeps the status message. */
export function parseErrorBody(raw: string): WireErrorBody {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const error = value.error
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      const message = typeof record.message === 'string' ? record.message : undefined
      const type = typeof record.type === 'string' ? record.type : undefined
      const code = typeof record.code === 'string' ? record.code : undefined
      return {
        message,
        detail: [code, type, message].filter(Boolean).join(' '),
      }
    }
    if (typeof value.message === 'string') return { message: value.message, detail: value.message }
  } catch {
    // Malformed error body: the HTTP status still identifies the failure.
  }
  return { detail: '' }
}

/** Map an HTTP status to a stable `LlmError` code (Copilot flavor of the DeepSeek mapping). */
export function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Parse a `retry-after` header (delta-seconds or HTTP date) into milliseconds. */
export function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Extract the provider request id used by the Copilot API (`x-request-id`). */
export function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-github-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/** Build the `LlmError` for one non-2xx provider response, retry metadata attached. */
export async function httpError(response: Response): Promise<LlmError> {
  const raw = await response.text().catch(() => '')
  const parsed = parseErrorBody(raw)
  const message = parsed.message ?? `Copilot API error (HTTP ${response.status})`
  const delay = providerRetryAfterMs(response.headers.get('retry-after'))
  const id = requestId(response.headers)
  return new LlmError(message, httpErrorCode(response.status, parsed.detail), {
    status: response.status,
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...id === undefined ? {} : { requestId: id },
  })
}

/** OpenAI chat-completions usage vocabulary. */
export interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Map OpenAI usage to disjoint harness counts; cache reads leave `inputTokens`. */
export function mapOpenAiUsage(usage: OpenAiUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Anthropic messages-shim usage vocabulary. */
export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Map Anthropic usage (two partial reports merge into one value). */
export function mapAnthropicUsage(...parts: AnthropicUsage[]): TokenUsage {
  const merged: AnthropicUsage = {}
  for (const part of parts) {
    if (part.input_tokens !== undefined) merged.input_tokens = part.input_tokens
    if (part.output_tokens !== undefined) merged.output_tokens = part.output_tokens
    if (part.cache_read_input_tokens !== undefined) merged.cache_read_input_tokens = part.cache_read_input_tokens
    if (part.cache_creation_input_tokens !== undefined) {
      merged.cache_creation_input_tokens = part.cache_creation_input_tokens
    }
  }
  const cacheRead = merged.cache_read_input_tokens
  const cacheWrite = merged.cache_creation_input_tokens
  return {
    inputTokens: (merged.input_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: merged.output_tokens ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
  }
}

/** Responses-API usage vocabulary. */
export interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/** Map Responses-API usage to disjoint harness counts. */
export function mapResponsesUsage(usage: ResponsesUsage): TokenUsage {
  const cacheRead = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.input_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
