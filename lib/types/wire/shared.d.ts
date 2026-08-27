/**
 * Shared wire-layer plumbing for the three Copilot protocols: SSE event
 * parsing (event name + data payload, framing by `eventsource-parser`),
 * protocol termination sentinels, HTTP error mapping to stable `LlmError`
 * codes, retry-after parsing, and usage mappers for the OpenAI and Anthropic
 * usage vocabularies.
 *
 * @module @huanlin/dsh-plugin-copilot/wire/shared
 */
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
/** One decoded SSE event: the (possibly empty) event name and its data payload. */
export interface SseEvent {
    event: string;
    data: string;
}
/**
 * Parse an SSE byte stream into `{event, data}` events. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment skipping, multi-`data:`
 * joining — is `eventsource-parser`'s. Comments and activity pulses go to the
 * optional callback. Unlike the DeepSeek adapter's data-only parser, the
 * three Copilot protocols have different terminators, so the raw events are
 * yielded and each protocol's translate owns its terminal check.
 */
export declare function parseSseEvents(stream: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<SseEvent>;
/** Parse one event's JSON payload; malformed JSON aborts with `MALFORMED_RESPONSE`. */
export declare function parseJsonPayload<T>(payload: string): T;
/** Parsed provider error body; both OpenAI (`error.message`) and Anthropic (`error.type/message`) shapes. */
export interface WireErrorBody {
    message?: string;
    detail: string;
}
/** Best-effort parse of a non-2xx body; a malformed gateway body keeps the status message. */
export declare function parseErrorBody(raw: string): WireErrorBody;
/** Map an HTTP status to a stable `LlmError` code (Copilot flavor of the DeepSeek mapping). */
export declare function httpErrorCode(status: number, detail: string): string;
/** Parse a `retry-after` header (delta-seconds or HTTP date) into milliseconds. */
export declare function providerRetryAfterMs(value: string | null): number | undefined;
/** Extract the provider request id used by the Copilot API (`x-request-id`). */
export declare function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined;
/** Build the `LlmError` for one non-2xx provider response, retry metadata attached. */
export declare function httpError(response: Response): Promise<LlmError>;
/** OpenAI chat-completions usage vocabulary. */
export interface OpenAiUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/** Map OpenAI usage to disjoint harness counts; cache reads leave `inputTokens`. */
export declare function mapOpenAiUsage(usage: OpenAiUsage): TokenUsage;
/** Anthropic messages-shim usage vocabulary. */
export interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}
/** Map Anthropic usage (two partial reports merge into one value). */
export declare function mapAnthropicUsage(...parts: AnthropicUsage[]): TokenUsage;
/** Responses-API usage vocabulary. */
export interface ResponsesUsage {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/** Map Responses-API usage to disjoint harness counts. */
export declare function mapResponsesUsage(usage: ResponsesUsage): TokenUsage;
