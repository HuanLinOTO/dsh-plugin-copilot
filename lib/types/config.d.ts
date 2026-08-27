/**
 * Plugin config for `@huanlin/dsh-plugin-copilot` (Schemastery, strict) and
 * the one explicit resolve step from raw config to validated connection
 * facts. Every field is optional in yml: missing values fall back to the
 * opencode-compatible defaults (public GitHub deployment, the shared opencode
 * device-flow client id, `GITHUB_COPILOT_TOKEN` as the credential-ref env).
 *
 * The same-named schema doubles as the settings-section shape, so a settings
 * edit reaches the next request without a restart (the adapter re-reads the
 * snapshot per operation).
 *
 * @module @huanlin/dsh-plugin-copilot/config
 */
import z from 'schemastery';
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
/** Shared device-flow OAuth client id of the opencode GitHub Copilot integration. */
export declare const OAUTH_CLIENT_ID = "Ov23li8tweQw6odWQebz";
/** GitHub API version header value opencode pins for the Copilot API. */
export declare const COPILOT_API_VERSION = "2026-06-01";
/** OAuth scope requested by the device flow (identical to opencode). */
export declare const OAUTH_SCOPE = "read:user";
/** Default credential-ref environment variable naming the GitHub OAuth token. */
export declare const DEFAULT_TOKEN_ENV = "GITHUB_COPILOT_TOKEN";
/** Default API base for the public GitHub deployment. */
export declare const PUBLIC_COPILOT_BASE_URL = "https://api.githubcopilot.com";
/** Default auth-store file name under the harness home. */
export declare const DEFAULT_AUTH_FILE_NAME = "github-copilot-auth.json";
/** Default TTL of the remote `/models` catalog cache. */
export declare const DEFAULT_MODELS_REFRESH_MS = 300000;
/** Default per-read idle bound for one provider stream. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default bound on accumulated base64 image payload per request. */
export declare const DEFAULT_MAX_REQUEST_IMAGE_BYTES: number;
/** Context capacity assumed for models the endpoint metadata does not describe. */
export declare const FALLBACK_CONTEXT_WINDOW = 128000;
/** Output cap assumed for models the endpoint metadata does not describe. */
export declare const FALLBACK_MAX_OUTPUT_TOKENS = 16384;
/** User-editable configuration for the copilot provider plugin. */
export interface CopilotConfig {
    /**
     * GitHub Enterprise Server / GHE.com domain (or URL) for data-residency and
     * self-hosted deployments; omission uses the public github.com deployment.
     */
    enterpriseUrl?: string;
    /** Device-flow OAuth client id; defaults to the shared opencode client id. */
    clientId?: string;
    /** GitHub API version sent as `X-GitHub-Api-Version`; defaults to `2026-06-01`. */
    apiVersion?: string;
    /**
     * Credential reference (environment-variable name) resolved per request when
     * no device-flow token is stored; defaults to `GITHUB_COPILOT_TOKEN`.
     */
    githubTokenEnv?: string;
    /** Auth-store file path (`~` expands); defaults to `{dshHome}/github-copilot-auth.json`. */
    authFile?: string;
    /** Advanced override of the Copilot API base; wins over `enterpriseUrl` derivation. */
    baseURL?: string;
    /** Remote `/models` catalog cache TTL in milliseconds (default five minutes). */
    modelsRefreshMs?: number;
    /** Effort id preselected for models whose effort list contains it. */
    defaultReasoningEffort?: string;
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Maximum accumulated base64 image payload per request (default 20 MiB). */
    maxRequestImageBytes?: number;
    /** Provider-owned model-request retry policy; omission uses the harness default. */
    retryPolicy?: RetryPolicyConfig;
}
/**
 * Schemastery schema for the plugin row and the settings section. Strict by
 * construction: unknown keys fail validation here.
 */
export declare const Config: z<CopilotConfig>;
/** One resolution's complete, validated connection facts. */
export interface CopilotConnection {
    /** Device-flow OAuth client id. */
    clientId: string;
    /** GitHub API version header value. */
    apiVersion: string;
    /**
     * Configured enterprise domain (scheme and trailing slash stripped), when
     * the deployment is GitHub Enterprise. The auth store may override this per
     * request: the domain the token was issued for wins, matching opencode.
     */
    enterpriseDomain?: string;
    /** Explicit API base override; wins over the enterprise derivation. */
    baseURL?: string;
    /** Credential reference of this same resolution, resolved per request. */
    githubTokenEnv: CredentialRef;
    /** Absolute auth-store file path of this same resolution. */
    authFile: string;
    /** Remote `/models` catalog cache TTL. */
    modelsRefreshMs: number;
    /** Adapter-configured default effort, when any. */
    defaultReasoningEffort?: string;
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
    /** Maximum accumulated base64 image payload in one request. */
    maxRequestImageBytes: number;
    /** Provider-owned model-request retry policy, already resolved. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Normalize an enterprise URL or domain to the bare host form opencode uses. */
export declare function normalizeEnterpriseDomain(url: string): string;
/**
 * Derive the Copilot API base for one deployment. An explicit override wins;
 * otherwise an enterprise domain routes to `https://copilot-api.{domain}` and
 * the public deployment to `https://api.githubcopilot.com` — the same
 * derivation as opencode's `base()` helper.
 */
export declare function copilotBaseUrl(baseURL: string | undefined, enterpriseDomain: string | undefined): string;
/** Default auth-store path under the resolved harness home. */
export declare function defaultAuthFile(): string;
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 */
export declare function resolveConnection(config: CopilotConfig): CopilotConnection;
