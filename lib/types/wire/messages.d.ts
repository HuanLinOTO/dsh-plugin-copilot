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
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CopilotModel } from '../copilot-models.ts';
import type { SseEvent } from './shared.ts';
import type { ImageResolutionOptions } from './chat.ts';
type WireContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: WireContent[];
    is_error?: boolean;
};
interface WireMessage {
    role: 'user' | 'assistant';
    content: WireContent[];
}
/** `/v1/messages` request body (Anthropic shim; `max_tokens` is required). */
export interface WireMessagesRequest {
    model: string;
    max_tokens: number;
    messages: WireMessage[];
    stream: true;
    system?: string;
    tools?: {
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
    }[];
    temperature?: number;
    stop_sequences?: string[];
    thinking?: {
        type: 'enabled';
        budget_tokens: number;
    };
}
/** Thinking budget for one effort id, or `undefined` when thinking stays off. */
export declare function thinkingBudgetOf(model: CopilotModel | undefined, effort: string | undefined): number | undefined;
/** Build the full `/v1/messages` request. `max_tokens` is mandatory here (even for gpt ids). */
export declare function serializeMessagesRequest(options: GenerateOptions, model: CopilotModel | undefined, images?: ImageResolutionOptions): Promise<WireMessagesRequest>;
/** Map the Anthropic stop_reason vocabulary to the harness FinishReason. */
export declare function mapStopReason(reason: string): FinishReason;
/**
 * Consume SSE events (terminated by `message_stop`) and yield StreamChunks
 * with the shared buffering discipline. `error` events abort with
 * `LlmError`; EOF before `message_stop` is `STREAM_CLOSED`.
 */
export declare function translateMessages(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk>;
export {};
