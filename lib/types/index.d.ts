/**
 * Register the {@link CopilotAdapter} for the `github-copilot` provider route
 * on `ctx.llm`, with connection facts resolved per request instead of frozen
 * at load: the plugin layers its `cordis.yml` entry config under the optional
 * `dsh-plugin-copilot` user-settings section (`ctx.settings`) and resolves the
 * GitHub bearer per request (the device-flow auth store first, then the
 * `GITHUB_COPILOT_TOKEN`-style credential ref), so a changed enterprise
 * domain, API version, or token reaches the very next request without
 * restarting anything, while an in-flight stream keeps the facts it started
 * with. The one registration-captured fact — the retry policy — re-registers
 * the route in place when it changes.
 *
 * Behavior parity target: opencode's GitHub Copilot provider (OAuth device
 * flow, pinned `X-GitHub-Api-Version`, endpoint routing across the chat
 * completions / responses / messages shims, picker + utility model split).
 *
 * @module @huanlin/dsh-plugin-copilot
 */
import type { Context } from '@deepseek-ai/cordis';
import { CopilotAdapter } from './adapter.ts';
import type { ResolvedCopilotAuth } from './adapter.ts';
import { Config, resolveConnection, copilotBaseUrl, normalizeEnterpriseDomain } from './config.ts';
import type { CopilotConfig, CopilotConnection } from './config.ts';
import { registerCopilotTools } from './tools.ts';
export { CopilotAdapter, Config, resolveConnection, copilotBaseUrl, normalizeEnterpriseDomain, registerCopilotTools, };
export type { ResolvedCopilotAuth, CopilotConfig, CopilotConnection };
export { AuthStoreError, loadStoredAuth, saveStoredAuth, clearStoredAuth } from './auth-store.ts';
export { startDeviceFlow, pollDeviceFlow } from './device-flow.ts';
export { STATIC_FALLBACK_MODELS, UTILITY_MODELS, endpointOf, prefersResponsesApi } from './copilot-models.ts';
export declare const name = "dsh-plugin-copilot";
export declare const inject: string[];
export declare function apply(ctx: Context, config: CopilotConfig): void;
