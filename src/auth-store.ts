/**
 * Durable auth store for the GitHub device-flow token: one JSON file under
 * the harness home (default `{dshHome}/github-copilot-auth.json`), written
 * with a temp-file + rename replace so a reader never observes a torn file.
 * A missing file means "not logged in"; a malformed file fails loud with a
 * typed error so silent credential loss cannot masquerade as logged-out.
 *
 * @module @huanlin/dsh-plugin-copilot/auth-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Auth-store format version; a mismatching value fails loud (no migrations). */
export const AUTH_STORE_VERSION = 1

/** The durable record the device-flow login writes. */
export interface StoredCopilotAuth {
  version: typeof AUTH_STORE_VERSION
  /** GitHub OAuth access token from the device flow; sent as the Copilot bearer. */
  githubToken: string
  /**
   * GitHub domain the token was issued for (`github.com` omitted), so the
   * enterprise deployment the user logged into wins over later config edits —
   * the same precedence as opencode's stored auth.
   */
  enterpriseDomain?: string
}

/** Typed failure of the auth store; `code` is a stable machine-routing string. */
export class AuthStoreError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthStoreError'
  }
}

/** Structural guard for the on-disk record; unknown extra keys are ignored. */
function parse(raw: string): StoredCopilotAuth {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new AuthStoreError('copilot auth store is not valid JSON', 'MALFORMED_AUTH_STORE', { cause: error })
  }
  if (typeof value !== 'object' || value === null) {
    throw new AuthStoreError('copilot auth store is not an object', 'MALFORMED_AUTH_STORE')
  }
  const record = value as Record<string, unknown>
  if (record.version !== AUTH_STORE_VERSION) {
    throw new AuthStoreError(
      `copilot auth store version ${String(record.version)} is not supported (expected ${AUTH_STORE_VERSION})`,
      'AUTH_STORE_VERSION',
    )
  }
  if (typeof record.githubToken !== 'string' || record.githubToken.length === 0) {
    throw new AuthStoreError('copilot auth store has no githubToken', 'MALFORMED_AUTH_STORE')
  }
  if (record.enterpriseDomain !== undefined
    && (typeof record.enterpriseDomain !== 'string' || record.enterpriseDomain.length === 0)) {
    throw new AuthStoreError('copilot auth store enterpriseDomain must be a non-empty string', 'MALFORMED_AUTH_STORE')
  }
  return {
    version: AUTH_STORE_VERSION,
    githubToken: record.githubToken,
    ...record.enterpriseDomain !== undefined ? { enterpriseDomain: record.enterpriseDomain } : {},
  }
}

/**
 * Read the stored auth. A missing file resolves `undefined` (not logged in);
 * a malformed or foreign-version file throws {@link AuthStoreError}.
 */
export async function loadStoredAuth(file: string): Promise<StoredCopilotAuth | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new AuthStoreError(`copilot auth store ${file} is unreadable`, 'AUTH_STORE_UNREADABLE', { cause: error })
  }
  return parse(raw)
}

/**
 * Atomically persist the auth record: the payload lands in a sibling temp
 * file first, then a `rename()` replace publishes it, so concurrent readers
 * see either the previous or the new record — never a partial one.
 */
export async function saveStoredAuth(file: string, auth: StoredCopilotAuth): Promise<void> {
  const payload = `${JSON.stringify(auth, null, 2)}\n`
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new AuthStoreError(`copilot auth store ${file} is unwritable`, 'AUTH_STORE_UNWRITABLE', { cause: error })
  }
}

/** Remove the auth record; a missing file is a successful no-op. */
export async function clearStoredAuth(file: string): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch (error) {
    throw new AuthStoreError(`copilot auth store ${file} could not be removed`, 'AUTH_STORE_UNWRITABLE', { cause: error })
  }
}
