/**
 * `@huanlin/dsh-plugin-copilot` — Copilot onboarding layer.
 *
 * This plugin no longer registers a `github-copilot` provider or adapter:
 * dsh 0.1.2-alpha.1's `dsh-llm-pi-ai` ships the pi-ai builtin catalog whose
 * Copilot provider already does everything the 0.1.x adapter did (OAuth
 * device-flow login, request headers, model catalog, three wire protocols),
 * and declaring the same provider twice fails the whole profile boot with
 * `DUPLICATE_DIRECTORY`. What the harness lacks is a way to *reach* that
 * built-in login from the WebUI — that is this plugin's whole job now:
 *
 *   - host half (this module): a `/copilot/api` HTTP gateway that proxies
 *     `ctx.authorization.begin()` onto the pi-ai Copilot flow, an idempotent
 *     settings autofill that writes `llm-pi-ai.providers.github-copilot = {}`
 *     (flipping the route from dormant to active), and a read-only
 *     `copilot_status` tool;
 *   - browser half (`src/client/`): a `settings.plugin.item` card in the
 *     Plugins settings page rendering the device-flow panel.
 *
 * @module @huanlin/dsh-plugin-copilot
 */
import type { Context } from '@deepseek-ai/cordis';
import { type SettingsNamespace } from '@deepseek-ai/dsh-settings';
import z from 'schemastery';
export { registerCopilotGateway } from './gateway.ts';
export { registerCopilotTools } from './tools.ts';
export { COPILOT_PROVIDER, COPILOT_RECORD_KEY, COPILOT_SCOPE, COPILOT_SETTINGS_NS, findCopilotFlow, grantModelIds, joinStatus, recordAddress, } from './status.ts';
export type { CopilotStatus, StatusSources } from './status.ts';
export declare const name = "dsh-plugin-copilot";
export declare const inject: string[];
/**
 * The plugin's own settings namespace: the card owns no configurable fields,
 * but the flow's enterprise question is answered from here.
 */
export declare const CARD_NAMESPACE: SettingsNamespace;
/** Plugin config. */
export interface Config {
    /**
     * GitHub Enterprise domain (e.g. `company.ghe.com`) the gateway answers the
     * Copilot flow's enterprise question with; blank serves github.com, which
     * is why the question never reaches the card by default.
     */
    enterpriseDomain: string;
}
export declare const Config: z<Config>;
/**
 * Plugin body: register the card namespace, the HTTP gateway, and the
 * status tool. Every host read goes through optional services (`ctx.get`)
 * so a composition without the authorization or credentials seam still
 * boots — the card then reports the missing pieces instead of failing load.
 * @param ctx - host plugin context.
 */
export declare function apply(ctx: Context, config?: Config): void;
