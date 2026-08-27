/**
 * Register the {@link CopilotAdapter} for the `github-copilot` provider route
 * on `ctx.llm`, with connection facts resolved per request instead of frozen
 * at load: the plugin layers its `cordis.yml` entry config under the optional
 * `dsh-plugin-copilot` user-settings section (`ctx.settings`) and resolves the
 * GitHub bearer per request (the device-flow auth store first, then the
 * `GITHUB_COPILOT_TOKEN`-style credential ref), so a changed enterprise
 * domain, API version, or token reaches the very next request without
 * restarting anything, while an in-flight stream keeps the facts it started
 * with. The one registration-captured fact — the retry policy — re-registers
 * the route in place when it changes.
 *
 * Behavior parity target: opencode's GitHub Copilot provider (OAuth device
 * flow, pinned `X-GitHub-Api-Version`, endpoint routing across the chat
 * completions / responses / messages shims, picker + utility model split).
 *
 * @module @huanlin/dsh-plugin-copilot
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { loadStoredAuth, AuthStoreError } from './auth-store.ts'
import type { StoredCopilotAuth } from './auth-store.ts'
import { CopilotAdapter } from './adapter.ts'
import type { ResolvedCopilotAuth } from './adapter.ts'
import { Config, resolveConnection, copilotBaseUrl, normalizeEnterpriseDomain } from './config.ts'
import type { CopilotConfig, CopilotConnection } from './config.ts'
import { registerCopilotTools } from './tools.ts'

export {
  CopilotAdapter,
  Config,
  resolveConnection,
  copilotBaseUrl,
  normalizeEnterpriseDomain,
  registerCopilotTools,
}
export type { ResolvedCopilotAuth, CopilotConfig, CopilotConnection }
export { AuthStoreError, loadStoredAuth, saveStoredAuth, clearStoredAuth } from './auth-store.ts'
export { startDeviceFlow, pollDeviceFlow } from './device-flow.ts'
export { STATIC_FALLBACK_MODELS, UTILITY_MODELS, endpointOf, prefersResponsesApi } from './copilot-models.ts'

export const name = 'dsh-plugin-copilot'
export const inject = ['llm', 'tools']

const NS = settingsNamespace('dsh-plugin-copilot')
/** The single provider route this plugin owns. */
const PROVIDER = 'github-copilot'

export function apply(ctx: Context, config: CopilotConfig): void {
  let current: () => CopilotConfig = () => config
  let lastRaw: CopilotConfig | undefined
  let lastGood: CopilotConnection | undefined
  const options = (): CopilotConnection => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConnection(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('dsh-plugin-copilot: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveAuth = async (connection: CopilotConnection): Promise<ResolvedCopilotAuth> => {
    // 1) The device-flow store is the login product: it wins, and its
    // enterprise domain travels with the token (opencode parity — a login
    // pins the deployment it was granted on).
    let stored: StoredCopilotAuth | undefined
    try {
      stored = await loadStoredAuth(connection.authFile)
    } catch (error) {
      throw new LlmError(
        `dsh-plugin-copilot: ${error instanceof AuthStoreError ? error.message : 'auth store is unreadable'}`
        + ` (${connection.authFile})`,
        'INVALID_CREDENTIAL',
        { cause: error },
      )
    }
    if (stored !== undefined) {
      return {
        token: assertUsableApiKey(stored.githubToken, name, 'device-flow'),
        ...stored.enterpriseDomain === undefined ? {} : { enterpriseDomain: stored.enterpriseDomain },
        source: 'device-flow',
      }
    }
    // 2) Credential-ref fallback for headless deployments, resolved per
    // request through the credential seam, then the trusted launch environment.
    const ref = connection.githubTokenEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) {
        return { token: assertUsableApiKey(hit.value, name, ref), source: 'credential' }
      }
    } else {
      // Without the seam there is no managed store to rank against, so the
      // launch environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return { token: assertUsableApiKey(ambient.value, name, ref), source: 'credential' }
      }
    }
    throw new LlmError(
      `dsh-plugin-copilot: no GitHub token for provider route "${PROVIDER}"; ask the model to run the`
      + ` copilot_login tool, or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CopilotAdapter({
    options,
    resolveAuth,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'GitHub Copilot', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })

  registerCopilotTools(ctx, { options, resolveAuth })
}
