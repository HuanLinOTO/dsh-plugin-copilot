/**
 * Durable auth store for the GitHub device-flow token: one JSON file under
 * the harness home (default `{dshHome}/github-copilot-auth.json`), written
 * with a temp-file + rename replace so a reader never observes a torn file.
 * A missing file means "not logged in"; a malformed file fails loud with a
 * typed error so silent credential loss cannot masquerade as logged-out.
 *
 * @module @huanlin/dsh-plugin-copilot/auth-store
 */
/** Auth-store format version; a mismatching value fails loud (no migrations). */
export declare const AUTH_STORE_VERSION = 1;
/** The durable record the device-flow login writes. */
export interface StoredCopilotAuth {
    version: typeof AUTH_STORE_VERSION;
    /** GitHub OAuth access token from the device flow; sent as the Copilot bearer. */
    githubToken: string;
    /**
     * GitHub domain the token was issued for (`github.com` omitted), so the
     * enterprise deployment the user logged into wins over later config edits —
     * the same precedence as opencode's stored auth.
     */
    enterpriseDomain?: string;
}
/** Typed failure of the auth store; `code` is a stable machine-routing string. */
export declare class AuthStoreError extends Error {
    readonly code: string;
    constructor(message: string, code: string, options?: {
        cause?: unknown;
    });
}
/**
 * Read the stored auth. A missing file resolves `undefined` (not logged in);
 * a malformed or foreign-version file throws {@link AuthStoreError}.
 */
export declare function loadStoredAuth(file: string): Promise<StoredCopilotAuth | undefined>;
/**
 * Atomically persist the auth record: the payload lands in a sibling temp
 * file first, then a `rename()` replace publishes it, so concurrent readers
 * see either the previous or the new record — never a partial one.
 */
export declare function saveStoredAuth(file: string, auth: StoredCopilotAuth): Promise<void>;
/** Remove the auth record; a missing file is a successful no-op. */
export declare function clearStoredAuth(file: string): Promise<void>;
