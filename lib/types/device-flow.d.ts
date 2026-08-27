/**
 * GitHub OAuth device flow (RFC 8628) for GitHub Copilot, behaviorally
 * identical to opencode's `auth.login.github-copilot` method: request a
 * device code from `{domain}/login/device/code`, show the verification URL
 * and user code, then poll `{domain}/login/oauth/access_token` until the
 * user approves, denies, or the code expires. `slow_down` honors the RFC's
 * +5s and a server-provided interval, always padded with the same 3s clock
 * skew margin opencode adds.
 *
 * `fetch` and `sleep` are injectable so the whole state machine unit-tests
 * offline.
 *
 * @module @huanlin/dsh-plugin-copilot/device-flow
 */
/** Extra polling delay so we never poll slightly before the server expects (opencode parity). */
export declare const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
/** Default polling interval when the device response omits one (RFC suggests 5s). */
export declare const DEFAULT_DEVICE_INTERVAL_S = 5;
/** One pending device-flow session, as the user sees it. */
export interface DeviceFlowStart {
    /** URL the user opens (`https://github.com/login/device` for github.com). */
    verificationUri: string;
    /** The short code the user types in. */
    userCode: string;
    /** Opaque device code used for polling. */
    deviceCode: string;
    /** Server-requested poll interval in milliseconds. */
    intervalMs: number;
    /** Seconds until the user code expires, when the server states one. */
    expiresInSeconds?: number;
}
/** How one polling session ended. */
export type DeviceFlowOutcome = {
    kind: 'authorized';
    githubToken: string;
} | {
    kind: 'denied';
} | {
    kind: 'expired';
} | {
    kind: 'failed';
    message: string;
};
/** Injectable transports for offline testing. */
export interface DeviceFlowDeps {
    fetchImpl?: typeof fetch;
    /** Resolves after `ms`; rejects when `signal` aborts first. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** Thrown when the caller cancels a polling session; tools map it to a cancel value. */
export declare class DeviceFlowCancelled extends Error {
    constructor();
}
export declare function deviceCodeUrl(domain: string): string;
export declare function accessTokenUrl(domain: string): string;
/** Default sleep: a timer that rejects with {@link DeviceFlowCancelled} when the signal aborts first. */
export declare function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void>;
/**
 * Begin a device-flow session on `domain` (github.com or an enterprise
 * host). The caller shows {@link DeviceFlowStart.verificationUri} and
 * {@link DeviceFlowStart.userCode} to the user, then hands the value to
 * {@link pollDeviceFlow}.
 */
export declare function startDeviceFlow(domain: string, clientId: string, deps?: DeviceFlowDeps): Promise<DeviceFlowStart>;
/**
 * Poll until the flow settles. Every wait honors `signal`; aborting throws
 * {@link DeviceFlowCancelled}. Terminal outcomes per RFC 8628 plus GitHub's
 * vocabulary: `access_denied` → denied, `expired_token` → expired, anything
 * else → failed with the server-provided description.
 */
export declare function pollDeviceFlow(start: DeviceFlowStart, domain: string, clientId: string, signal: AbortSignal, deps?: DeviceFlowDeps): Promise<DeviceFlowOutcome>;
