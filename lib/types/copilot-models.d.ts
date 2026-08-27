/**
 * Copilot model catalog: remote `/models` metadata mapped into the internal
 * {@link CopilotModel} shape (endpoint routing, capability extraction, usable
 * filter) and into harness `LlmModelInfo` / `LlmResolvedModelInfo` values.
 * Selection semantics mirror opencode: picker-enabled models surface in the
 * picker, utility models stay requestable for session titles, and
 * `policy.state: 'disabled'` or missing limits/tool-call capability drop a
 * model from the catalog entirely.
 *
 * @module @harness/dsh-plugin-copilot/models
 */
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import type { CopilotConnection } from './config.ts';
/** Wire protocols the Copilot API exposes per model. */
export type CopilotEndpoint = 'chat' | 'responses' | 'messages';
/** The subset of a `/models` item this adapter consumes (tolerant of extras). */
export interface RemoteModel {
    model_picker_enabled?: boolean;
    id?: string;
    name?: string;
    version?: string;
    supported_endpoints?: string[];
    policy?: {
        state?: string;
    };
    capabilities?: {
        family?: string;
        limits?: {
            max_context_window_tokens?: number;
            max_output_tokens?: number;
            max_prompt_tokens?: number;
            vision?: {
                supported_media_types?: string[];
            };
        };
        supports?: {
            adaptive_thinking?: boolean;
            max_thinking_budget?: number;
            min_thinking_budget?: number;
            reasoning_effort?: string[];
            streaming?: boolean;
            structured_outputs?: boolean;
            tool_calls?: boolean;
            vision?: boolean;
        };
    };
}
/** Internal catalog entry for one usable Copilot model. */
export interface CopilotModel {
    /** Catalog key (the remote model id). */
    id: string;
    /** Display name. */
    name: string;
    /** Capability family reported by the endpoint (gpt, claude, …). */
    family?: string;
    /** Wire protocol this model routes to. */
    endpoint: CopilotEndpoint;
    /** Whether the endpoint lists the model in the model picker. */
    pickerEnabled: boolean;
    /** Combined context capacity, when disclosed. */
    contextWindow?: number;
    /** Per-request output cap, when disclosed. */
    maxOutputTokens?: number;
    /** Image input accepted (vision capability or image media types). */
    supportsVision: boolean;
    /** PDF input accepted (vision media type `application/pdf`). */
    supportsPdf: boolean;
    /** Verbatim effort vocabulary when the model is effort-driven (GPT-5 class). */
    reasoningEfforts?: string[];
    /** Thinking budget ceiling when the model is budget-driven (Claude class). */
    maxThinkingBudget?: number;
    /** DSH-side effort/budget derivation of {@link CopilotModel.maxThinkingBudget}. */
    thinkingBudgets?: {
        low: number;
        high: number;
        max: number;
    };
}
/** Utility models opencode uses for title generation; picker-excluded but requestable. */
export declare const UTILITY_MODELS: readonly ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];
/**
 * Static best-effort catalog for requests made before login (or while the
 * remote listing is unreachable). Intentionally small: the remote `/models`
 * endpoint is the authoritative catalog once a token exists.
 */
export declare const STATIC_FALLBACK_MODELS: readonly CopilotModel[];
/**
 * opencode's Responses-API routing rule: GPT-5 class models (except the mini
 * variants, which still need chat completions) prefer `/responses`.
 */
export declare function prefersResponsesApi(modelId: string): boolean;
/** Endpoint routing: `/v1/messages` first, then `/responses`, then `/chat/completions`; unknown falls to the GPT-5 heuristic. */
export declare function endpointOf(modelId: string, supportedEndpoints: readonly string[] | undefined): CopilotEndpoint;
/** opencode's usable filter: disabled policy or missing limits/capability drops the model. */
export declare function isUsableRemote(item: RemoteModel): boolean;
/** Map one usable remote item to the internal catalog entry. */
export declare function buildModel(item: RemoteModel): CopilotModel;
/** `/models` response envelope. */
export interface RemoteModelCatalog {
    data?: RemoteModel[];
}
/** Fetch the remote catalog with the headers one authenticated request carries. */
export declare function fetchRemoteModels(baseURL: string, headers: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<CopilotModel[]>;
/**
 * Catalog selection for harness surfaces: picker-enabled models plus the
 * utility models (which stay requestable for session titles even though the
 * endpoint hides them from its picker).
 */
export declare function selectableModels(catalog: readonly CopilotModel[]): CopilotModel[];
/** Map catalog entries to advisory `LlmModelInfo` values. */
export declare function toModelInfos(provider: string, catalog: readonly CopilotModel[]): LlmModelInfo[];
/**
 * Exact-route metadata for one model. Unknown models resolve with the
 * fallback capacities and text-only input (declaring an unverified image
 * capability would let the host persist input the endpoint may reject).
 */
export declare function toResolvedModel(provider: string, model: CopilotModel | undefined, modelId: string, connection: CopilotConnection): LlmResolvedModelInfo;
