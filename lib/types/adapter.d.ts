/**
 * `CopilotAdapter`: fetch + SSE against the GitHub Copilot API, emitting
 * harness StreamChunks. One instance serves the whole `github-copilot`
 * provider route; the wire protocol per request follows the model's routed
 * endpoint (`/v1/messages`, `/responses`, or `/chat/completions`).
 *
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the GitHub bearer through a per-request
 * resolver, so the registering plugin owns validation, layering, and
 * credential policy (device-flow store, credential-ref fallback).
 *
 * @module @huanlin/dsh-plugin-copilot/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CopilotConnection } from './config.ts';
/** The bearer-token resolution the plugin owns, per request. */
export interface ResolvedCopilotAuth {
    /** GitHub OAuth token sent as the Copilot API bearer. */
    token: string;
    /**
     * Deployment domain the token belongs to (enterprise only); the token's
     * domain wins over configured facts so a login pins its own deployment.
     */
    enterpriseDomain?: string;
    /** Where the token came from, for diagnostics. */
    source: 'device-flow' | 'credential';
}
/** Constructor options for {@link CopilotAdapter}: the operation-local resolution hooks the plugin owns. */
export interface CopilotAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => CopilotConnection;
    /**
     * Resolve the GitHub bearer for the connection facts of one request. The
     * snapshot is passed in — never re-read — so the endpoint and the secret
     * sent to it always come from the same resolution generation. Throws
     * `LlmError` `MISSING_CREDENTIAL` when no token is available anywhere.
     */
    resolveAuth: (connection: CopilotConnection) => Promise<ResolvedCopilotAuth>;
    /** Resolve the current durable attachment service; absence rejects image input. */
    resolveAttachments: () => AttachmentStore | undefined;
    /** Injectable transport for offline tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * The Copilot provider adapter. One stable signal reaches both initial fetch
 * and body reads; caller aborts map to `ABORTED`, the configured per-read
 * idle watchdog maps to `TIMEOUT`.
 */
export declare class CopilotAdapter extends LlmAdapter {
    private readonly config;
    private cache;
    private ongoingRefresh;
    constructor(config: CopilotAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    /**
     * Advisory model catalog: picker-enabled plus utility models from the
     * remote listing, or the static fallback when no token exists yet or the
     * endpoint is unreachable. Never throws — an advisory catalog must not
     * break a lookup.
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** Exact-route metadata from the latest catalog snapshot (fallback capacities for unknown ids). */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** Fresh-or-stale catalog snapshot; refreshes in the background when stale. */
    private catalogOrFallback;
    private refreshCatalog;
    private doRefreshCatalog;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
