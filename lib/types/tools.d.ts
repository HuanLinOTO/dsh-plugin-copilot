/**
 * Model-facing Copilot status tool. Login interaction belongs to the WebUI
 * card; this tool only reports the onboarding state so an agent can answer
 * "am I signed in to Copilot?" without touching credentials.
 *
 * @module @huanlin/dsh-plugin-copilot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { StatusSources } from './status.ts';
/**
 * Register the status tool.
 * @param ctx - host plugin context carrying `ctx.tools`.
 * @param sources - the live host reads the status join uses.
 */
export declare function registerCopilotTools(ctx: Context, sources: StatusSources): void;
