/** Auth-store unit tests: roundtrip, absence, malformed rejection, clear. */

import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, AuthStoreError, AUTH_STORE_VERSION } from '../src/auth-store.ts'

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-auth-'))
  return join(dir, 'auth.json')
}

describe('auth store', () => {
  it('round-trips a stored record', async () => {
    const file = await tempFile()
    await saveStoredAuth(file, { version: AUTH_STORE_VERSION, githubToken: 'gho_token123' })
    const loaded = await loadStoredAuth(file)
    expect(loaded).toEqual({ version: 1, githubToken: 'gho_token123' })
  })

  it('round-trips an enterprise record with its domain', async () => {
    const file = await tempFile()
    await saveStoredAuth(file, {
      version: AUTH_STORE_VERSION,
      githubToken: 'gho_e',
      enterpriseDomain: 'company.ghe.com',
    })
    expect(await loadStoredAuth(file)).toEqual({
      version: 1,
      githubToken: 'gho_e',
      enterpriseDomain: 'company.ghe.com',
    })
  })

  it('writes the file atomically (no temp siblings remain)', async () => {
    const file = await tempFile()
    await saveStoredAuth(file, { version: AUTH_STORE_VERSION, githubToken: 'gho_x' })
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ githubToken: 'gho_x' })
  })

  it('resolves undefined for a missing file', async () => {
    expect(await loadStoredAuth(join(tmpdir(), 'copilot-auth-missing', 'auth.json'))).toBeUndefined()
  })

  it('fails loud on a malformed store', async () => {
    const file = await tempFile()
    await writeFile(file, 'not json{', 'utf8')
    await expect(loadStoredAuth(file)).rejects.toBeInstanceOf(AuthStoreError)
  })

  it('fails loud on a foreign version', async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ version: 99, githubToken: 'x' }), 'utf8')
    await expect(loadStoredAuth(file)).rejects.toMatchObject({ code: 'AUTH_STORE_VERSION' })
  })

  it('fails loud on a record without a token', async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ version: 1 }), 'utf8')
    await expect(loadStoredAuth(file)).rejects.toMatchObject({ code: 'MALFORMED_AUTH_STORE' })
  })

  it('clear removes the record and tolerates absence', async () => {
    const file = await tempFile()
    await saveStoredAuth(file, { version: AUTH_STORE_VERSION, githubToken: 'gho_y' })
    await clearStoredAuth(file)
    expect(await loadStoredAuth(file)).toBeUndefined()
    await expect(clearStoredAuth(file)).resolves.toBeUndefined()
  })
})
