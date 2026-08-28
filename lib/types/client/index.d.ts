/**
 * dsh-plugin-copilot — browser half.
 *
 * One registration: a `settings.plugin.item` card (key `dsh-plugin-copilot`)
 * in the Plugins settings page, rendering the Copilot onboarding state
 * machine (sign-in device-flow panel, route activation, sign-out) through
 * the host's `/copilot/api` gateway.
 *
 * @module @huanlin/dsh-plugin-copilot/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The Copilot onboarding card labels. */
        'dsh-plugin-copilot': import('./locales.ts').CopilotKey;
    }
}
/** Required services: the slot ledger and the locale dictionaries. */
export declare const inject: string[];
/**
 * Client plugin body: register the locale dictionaries and the settings card.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
