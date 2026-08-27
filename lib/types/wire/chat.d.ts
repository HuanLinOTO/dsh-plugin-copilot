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
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CopilotModel } from '../copilot-models.ts';
import type { SseEvent } from './shared.ts';
/** Dependencies required only when the request contains image input. */
export interface ImageResolutionOptions {
    /** Durable resolver for canonical image references. */
    attachments: AttachmentStore;
    /** Cancellation shared with the provider request. */
    signal: AbortSignal;
    /** Positive bound on accumulated base64 image payload. */
    maxImageBytes: number;
}
interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
type WireContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: {
        url: string;
    };
};
interface WireMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | WireContentPart[];
    tool_call_id?: string;
    tool_calls?: WireToolCall[];
}
/** `/chat/completions` request body (streaming always on). */
export interface WireChatRequest {
    model: string;
    messages: WireMessage[];
    stream: true;
    stream_options: {
        include_usage: true;
    };
    tools?: {
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    }[];
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
    reasoning_effort?: string;
}
/** Whether the gpt-family output-token omission applies (opencode parity: substring match). */
export declare function omitsMaxTokens(modelId: string): boolean;
/**
 * Build the full chat-completions request. Always streaming with usage
 * reporting; optional fields are omitted rather than sent as null.
 * gpt-family models never carry `max_tokens` (GitHub Copilot CLI parity).
 */
export declare function serializeChatRequest(options: GenerateOptions, model: CopilotModel | undefined, images?: ImageResolutionOptions): Promise<WireChatRequest>;
/** Map the wire finish_reason vocabulary to the harness FinishReason. */
export declare function mapFinishReason(reason: string): FinishReason;
/**
 * Consume SSE events (terminated by the `data: [DONE]` sentinel) and yield
 * StreamChunks. Deltas stream through as they arrive; `block-end`s, usage,
 * and finish are deferred to the sentinel, so no chunk follows `finish`. A
 * `stop` (or absent) finish with no opened blocks is a degenerate completion
 * and maps to an `EMPTY_RESPONSE` error finish.
 */
export declare function translateChat(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk>;
export {};
