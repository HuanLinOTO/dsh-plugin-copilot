/**
 * Copilot onboarding state shared by the host gateway and the `copilot_status`
 * tool: which authorization flow serves the `llm-pi-ai` Copilot record, whether
 * that record is stored, and whether the `llm-pi-ai` settings namespace carries
 * a `github-copilot` provider profile (the fact that activates the route).
 *
 * @module @huanlin/dsh-plugin-copilot/status
 */
import type { AuthorizationEntry } from '@deepseek-ai/dsh-authorization';
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials';
/** The provider route and record id this plugin bootstraps. */
export declare const COPILOT_PROVIDER = "github-copilot";
/** Scope owning the Copilot credential record (dsh-llm-pi-ai's plugin name). */
export declare const COPILOT_SCOPE = "llm-pi-ai";
/** Settings namespace whose `providers` dict carries the Copilot profile. */
export declare const COPILOT_SETTINGS_NS = "llm-pi-ai";
/**
 * The credential record a pi-ai Copilot login writes.
 *
 * Spelled from the two public constants rather than imported from
 * `@deepseek-ai/dsh-llm-pi-ai`: a third-party plugin must not take a
 * runtime dependency on an internal plugin package, and the record address
 * is exactly `credentialKey('llm-pi-ai', 'github-copilot')`.
 */
export declare const COPILOT_RECORD_KEY: CredentialKey;
/** The joined record address, as the authorization flow registry reports it. */
export declare function recordAddress(key: CredentialKey): string;
/**
 * Find the pi-ai Copilot authorization flow without hand-composing its key:
 * the flow registry is the authority on which keys exist, so the join is by
 * scope + id segments of each registered flow's key.
 * @param entries - every registered authorization flow.
 * @returns the entry whose record is the Copilot one, or undefined.
 */
export declare function findCopilotFlow(entries: readonly AuthorizationEntry[]): AuthorizationEntry | undefined;
/**
 * Pull the model ids a stored pi-ai OAuth grant reports as usable by this
 * account. pi-ai writes `availableModelIds` at login and rewrites it on every
 * token refresh; anything else — an api-key record, an absent store, an
 * unexpected payload — reads as unknown rather than empty, so a surface can
 * stay silent instead of claiming the account has no models.
 * @param record - the credential record as stored, or undefined.
 * @returns the usable model ids, or undefined when unknown.
 */
export declare function grantModelIds(record: CredentialRecord | undefined): readonly string[] | undefined;
/** What the settings card and the status tool render. */
export interface CopilotStatus {
    /** Whether the pi-ai Copilot authorization flow is registered. */
    flowAvailable: boolean;
    /** Whether a credential record is stored for the Copilot key. */
    loggedIn: boolean;
    /** Whether the `llm-pi-ai` settings section declares a `github-copilot` profile. */
    profileActivated: boolean;
    /** Whether an authorization attempt for the Copilot key is running right now. */
    inFlight: boolean;
    /**
     * Model ids the stored grant reports as usable by this account, or undefined
     * when not signed in / unknown. pi-ai already filters its provider catalog by
     * this list; surfacing it is feedback, not enforcement.
     */
    models: readonly string[] | undefined;
}
/** Host-side reads backing one status join. */
export interface StatusSources {
    /** Live flow registry listing. */
    listFlows(): readonly AuthorizationEntry[];
    /** Presence/kind facts for the Copilot record, or `undefined` without a credential store. */
    describeRecord(key: CredentialKey): Promise<{
        configured: boolean;
        kind?: string;
    } | undefined>;
    /** The resolved `llm-pi-ai` section value, or `undefined` when unregistered. */
    settingsSection(): Record<string, unknown> | undefined;
    /** The stored grant's usable model ids, or `undefined` when unknown. */
    models(): Promise<readonly string[] | undefined>;
}
/**
 * Join the facts the card shows.
 * @param sources - the live host reads.
 * @returns the card status; `loggedIn` is false when no credential store is mounted.
 */
export declare function joinStatus(sources: StatusSources): Promise<CopilotStatus>;
