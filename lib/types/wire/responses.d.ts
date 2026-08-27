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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CopilotModel } from '../copilot-models.ts';
import type { SseEvent } from './shared.ts';
import type { ImageResolutionOptions } from './chat.ts';
type InputPart = {
    type: 'input_text';
    text: string;
} | {
    type: 'input_image';
    image_url: string;
};
type InputItem = {
    role: 'system' | 'user' | 'assistant';
    content: string | InputPart[];
} | {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
} | {
    type: 'function_call_output';
    call_id: string;
    output: string;
};
/** `/responses` request body (always streaming, fully stateless input). */
export interface WireResponsesRequest {
    model: string;
    input: InputItem[];
    stream: true;
    instructions?: string;
    tools?: {
        type: 'function';
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict: false;
    }[];
    temperature?: number;
    max_output_tokens?: number;
    reasoning?: {
        effort: string;
    };
}
/** Build the full `/responses` request. gpt-family models omit the output cap (opencode parity). */
export declare function serializeResponsesRequest(options: GenerateOptions, model: CopilotModel | undefined, images?: ImageResolutionOptions): Promise<WireResponsesRequest>;
/**
 * Consume SSE events (terminated by `response.completed` / `response.incomplete`)
 * and yield StreamChunks with the same buffering discipline as the chat
 * protocol. `response.failed` and top-level `error` events abort with
 * `LlmError`; EOF before a terminal event is `STREAM_CLOSED`.
 */
export declare function translateResponses(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk>;
export {};
