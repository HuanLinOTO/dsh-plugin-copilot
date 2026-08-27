/**
 * Model-facing GitHub Copilot login tools. DSH has no CLI auth seam, so the
 * opencode `auth login` flow maps onto two cooperative tools: `copilot_login`
 * starts the device flow and surfaces the verification URL and user code
 * (also persisted as a plugin notice via `deferContext`), and
 * `copilot_login_wait` polls until the user approves — split so no tool
 * blocks while the human is still walking to the browser. `copilot_status`
 * and `copilot_logout` round out account management.
 *
 * @module @huanlin/dsh-plugin-copilot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CopilotConnection } from './config.ts';
import type { ResolvedCopilotAuth } from './adapter.ts';
/** Services the login tools resolve per call. */
export interface CopilotToolDeps {
    /** Current validated connection facts. */
    options: () => CopilotConnection;
    /** Per-call bearer resolution (device-flow store, credential-ref fallback). */
    resolveAuth: (connection: CopilotConnection) => Promise<ResolvedCopilotAuth>;
}
/**
 * Register the four tools. One pending login slot lives in this closure:
 * a fresh `copilot_login` overwrites it, and a restart drops it (the user
 * simply starts the flow again — no durable half-logged-in state exists).
 */
export declare function registerCopilotTools(ctx: Context, deps: CopilotToolDeps): void;
