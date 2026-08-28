import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { CopilotCardState } from './controller.ts';
import type { CopilotAuthController } from './controller.ts';
/** Inject face: the shared controller. */
export interface CopilotCardInjected {
    readonly controller: CopilotAuthController;
    readonly useCard: <S>(select: (state: CopilotCardState) => S) => S;
}
/** Full props: locale seat + inject. */
export type CopilotCardProps = PropsLocale<'dsh-plugin-copilot'> & CopilotCardInjected;
/**
 * Render the Copilot onboarding card.
 * @param props - locale + controller inject.
 * @returns a `<li>` card element.
 */
export declare function CopilotAuthCard({ t, controller, useCard }: CopilotCardProps): import("react").JSX.Element;
