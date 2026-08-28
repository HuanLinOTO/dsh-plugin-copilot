/**
 * Host-side HTTP gateway exposing the Copilot onboarding face to the browser
 * through a self-hosted `/copilot/api` route (same-origin only).
 *
 * Wire shape (POST, JSON envelope `{ ok, value | error }` like the
 * sidebar-brand-text precedent):
 *   status  → { flowAvailable, loggedIn, profileActivated, inFlight, models }
 *   login   → long-polls one device-flow attempt; intermediate notices are
 *             polled via `events` (see below) — the request resolves only when
 *             the attempt settles (authorized / cancelled / error)
 *   cancel  → withdraw the running attempt
 *   events  → { since } → notices emitted after sequence `since`
 *   logout  → delete the Copilot credential record
 *   autofill → idempotently write `llm-pi-ai.providers.github-copilot = {}`
 *
 * `login` cannot ride a single request/response cleanly because the device
 * flow takes minutes, so the gateway keeps a bounded notice ring the client
 * polls; the login request itself resolves at settlement.
 *
 * @module @huanlin/dsh-plugin-copilot/gateway
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AuthorizationEntry, AuthorizationInteraction, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization';
import type { CredentialKey } from '@deepseek-ai/dsh-credentials';
/** One notice as the browser consumes it. */
export interface CopilotNoticeEvent {
    /** Monotonic sequence; the client polls with the last one it saw. */
    seq: number;
    /** Notice text. */
    message: string;
    /** Page the human must open, when the notice carries one. */
    url?: string;
    /** Code the human must enter there, when the notice carries one. */
    code?: string;
}
/** One queued prompt question the browser must answer. */
export interface CopilotPromptEvent {
    /** Monotonic sequence in the same stream as notices. */
    seq: number;
    /** Prompt shape: text / secret / select (see the authorization seam). */
    prompt: AuthorizationPrompt;
}
/** Login call status: settlement or in-progress. */
export type LoginOutcome = {
    status: 'authorized';
} | {
    status: 'cancelled';
} | {
    status: 'error';
    message: string;
};
/** Host capabilities the gateway drives. */
export interface GatewayDeps {
    /** The live flow registry listing. */
    listFlows(): readonly AuthorizationEntry[];
    /** Begin one authorization attempt. */
    begin(request: {
        key: CredentialKey;
        interaction: AuthorizationInteraction;
        signal?: AbortSignal;
    }): Promise<{
        status: 'authorized' | 'cancelled';
    }>;
    /** Withdraw the running attempt for a key. */
    cancel(key: CredentialKey): void;
    /** Record presence facts; undefined without a credential store. */
    describeRecord(key: CredentialKey): Promise<{
        configured: boolean;
        kind?: string;
    } | undefined>;
    /** Delete the stored record; undefined without a credential store. */
    deleteRecord(key: CredentialKey): Promise<void>;
    /** The resolved `llm-pi-ai` section, or undefined when unregistered. */
    settingsSection(): Record<string, unknown> | undefined;
    /** The stored grant's usable model ids, or `undefined` when unknown. */
    models(): Promise<readonly string[] | undefined>;
    /**
     * The installed pi-ai catalog models for the Copilot route, or `undefined`
     * when the llm service is unavailable. The narrow step needs the catalog's
     * ids: a profile `models` entry naming an id the catalog does not describe
     * would refuse the whole route at write time, because the shipped Copilot
     * models do not share one wire protocol to default it to.
     */
    catalogModels(): Promise<readonly {
        id: string;
    }[] | undefined>;
    /** Merge a patch into the `llm-pi-ai` user settings section. */
    updateSettings(patch: Record<string, unknown>): Promise<void>;
    /**
     * The configured GitHub Enterprise domain, auto-answered for the Copilot
     * flow's enterprise question; blank or undefined serves github.com.
     */
    enterpriseDomain?: string;
}
/**
 * Register the `/copilot/api` route.
 *
 * @param ctx - host context carrying `webServer`.
 * @param deps - the host capabilities the route drives.
 * @returns disposer removing the route.
 */
export declare function registerCopilotGateway(ctx: Context, deps: GatewayDeps): () => void;
