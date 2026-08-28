/**
 * `CopilotAuthController` — client-side state machine for the Copilot card.
 *
 * Drives the host's `/copilot/api` gateway: one `status` load, a login flow
 * that starts the attempt and then polls the sequenced `events` stream
 * (device-code notices, progress, prompts to answer) until the attempt
 * settles, and logout / autofill actions. The store is the single render
 * source; the card is a pure projection of it.
 *
 * @module @huanlin/dsh-plugin-copilot/client/controller
 */
import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { CopilotStatus } from '../status.ts';
/** One sequenced gateway event as the client consumes it. */
export interface CopilotClientEvent {
    seq: number;
    kind: 'notice' | 'prompt';
    message?: string;
    url?: string;
    code?: string;
    prompt?: {
        kind: 'text' | 'secret' | 'select';
        message: string;
        placeholder?: string;
        options?: readonly {
            id: string;
            label: string;
        }[];
    };
}
/** The card's render state. */
export interface CopilotCardState {
    /** Whether the first status read answered. */
    loaded: boolean;
    /** The joined host status. */
    status: CopilotStatus;
    /** Login lifecycle: idle / running / terminal outcome. */
    login: {
        kind: 'idle';
    } | {
        kind: 'running';
    } | {
        kind: 'success';
    } | {
        kind: 'error';
        message: string;
    } | {
        kind: 'cancelled';
    };
    /** Notices and the latest unanswered prompt, in arrival order. */
    events: readonly CopilotClientEvent[];
    /** The last device code shown (for the copy button). */
    deviceCode: string | undefined;
    /** The verification URL of the latest device-code notice. */
    verificationUrl: string | undefined;
    /** The prompt awaiting an answer, when one is open. */
    openPrompt: CopilotClientEvent | undefined;
    /** Copy button feedback. */
    copied: boolean;
    /** Action in flight (disables buttons). */
    busy: boolean;
}
/**
 * Controller managing the Copilot card lifecycle. Constructed once in the
 * client `apply()`; polls only while a login attempt is running or the card
 * holds an unanswered prompt.
 */
export declare class CopilotAuthController {
    readonly store: SnapshotStore<CopilotCardState>;
    private cursor;
    private pollTimer;
    private disposed;
    constructor();
    /** Load the joined status from the host. */
    load(): Promise<void>;
    /** Start a login attempt, then poll events until settlement. */
    login(): Promise<void>;
    /** Withdraw the running attempt. */
    cancel(): Promise<void>;
    /** Answer the open prompt. */
    answer(answer: string, declined: boolean): Promise<void>;
    /** Delete the stored credential record. */
    logout(): Promise<void>;
    /** Write the provider profile (idempotent on the host side). */
    autofill(): Promise<void>;
    /** Copy-button feedback. */
    markCopied(): void;
    /** Stop polling and further actions; called on fiber disposal. */
    dispose(): void;
    /** Fold one settlement into the card state and refresh the join. */
    private finishLogin;
    /** Poll the event stream once; reschedules while the attempt runs. */
    private pollOnce;
    /** Fold one sequenced event into the card state. */
    private applyEvent;
    /** Schedule the next poll, collapsing overlapping timers. */
    private schedulePoll;
}
