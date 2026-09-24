import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CopilotCardState } from './controller.ts';
import type { CopilotAuthController } from './controller.ts';
/** Inject face: the shared controller. */
export interface CopilotCardInjected {
    readonly controller: CopilotAuthController;
    readonly useCard: <S>(select: (state: CopilotCardState) => S) => S;
}
/** Full props: the `plugins.row.config` owner share (view + form), locale seat, and inject. */
export type CopilotCardProps = PropsRuntime<'plugins.row.config'> & PropsLocale<'dsh-plugin-copilot'> & CopilotCardInjected;
/**
 * Render the Copilot onboarding card.
 * @param props - locale + controller inject.
 * @returns a `<li>` card element.
 */
export declare function CopilotAuthCard({ view, t, controller, useCard }: CopilotCardProps): string | import("react").JSX.Element;
