/**
 * Locale dictionaries for the `dsh-plugin-copilot` card namespace.
 *
 * @module @huanlin/dsh-plugin-copilot/client/locales
 */
/** The locale keys the Copilot card reads. */
export type CopilotKey = 'card.intro' | 'card.unsupported' | 'card.signedIn' | 'card.signedOut' | 'card.routeActive' | 'card.routeDormant' | 'card.models' | 'action.signIn' | 'action.signOut' | 'action.cancel' | 'action.retry' | 'action.activate' | 'action.syncModels' | 'action.openUrl' | 'action.copyCode' | 'action.copied' | 'action.decline' | 'action.submit' | 'state.pending' | 'state.pendingPrompt' | 'state.working' | 'state.success' | 'state.error' | 'notice.deviceCode' | 'notice.polling' | 'prompt.placeholder' | 'prompt.answer';
/** The locale namespace name; matches the `locale: NS` passed at slot register. */
export declare const NS = "dsh-plugin-copilot";
/** English dictionary. */
export declare const en: Record<CopilotKey, string>;
/** Chinese dictionary. */
export declare const zh: Record<CopilotKey, string>;
