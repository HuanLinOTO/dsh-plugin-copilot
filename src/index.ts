/**
 * `@huanlin/dsh-plugin-copilot` — Copilot onboarding layer.
 *
 * This plugin no longer registers a `github-copilot` provider or adapter:
 * dsh 0.1.2-alpha.1's `dsh-llm-pi-ai` ships the pi-ai builtin catalog whose
 * Copilot provider already does everything the 0.1.x adapter did (OAuth
 * device-flow login, request headers, model catalog, three wire protocols),
 * and declaring the same provider twice fails the whole profile boot with
 * `DUPLICATE_DIRECTORY`. What the harness lacks is a way to *reach* that
 * built-in login from the WebUI — that is this plugin's whole job now:
 *
 *   - host half (this module): a `/copilot/api` HTTP gateway that proxies
 *     `ctx.authorization.begin()` onto the pi-ai Copilot flow, an idempotent
 *     settings autofill that writes `llm-pi-ai.providers.github-copilot = {}`
 *     (flipping the route from dormant to active), and a read-only
 *     `copilot_status` tool;
 *   - browser half (`src/client/`): a row-config card on the
 *     Plugins page rendering the device-flow panel.
 *
 * @module @huanlin/dsh-plugin-copilot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerCopilotGateway } from './gateway.ts'
import { registerCopilotTools } from './tools.ts'
import { COPILOT_PROVIDER, COPILOT_RECORD_KEY, COPILOT_SETTINGS_NS, grantModelIds, joinStatus } from './status.ts'
import type { StatusSources } from './status.ts'

export { registerCopilotGateway } from './gateway.ts'
export { registerCopilotTools } from './tools.ts'
export {
  COPILOT_PROVIDER, COPILOT_RECORD_KEY, COPILOT_SCOPE, COPILOT_SETTINGS_NS,
  findCopilotFlow, grantModelIds, joinStatus, recordAddress,
} from './status.ts'
export type { CopilotStatus, StatusSources } from './status.ts'

export const name = 'dsh-plugin-copilot'
export const inject = ['tools', 'webServer']

/**
 * The plugin's own settings namespace: the card owns no configurable fields,
 * but the flow's enterprise question is answered from here.
 */
export const CARD_NAMESPACE = 'dsh-plugin-copilot' as SettingsNamespace

/** Plugin config. */
export interface Config {
  /**
   * GitHub Enterprise domain (e.g. `company.ghe.com`) the gateway answers the
   * Copilot flow's enterprise question with; blank serves github.com, which
   * is why the question never reaches the card by default. Volatile so a
   * profile-form edit reaches the next sign-in without a remount.
   */
  enterpriseDomain: Volatile<string>
}

export const Config: z<Config> = z.object({
  enterpriseDomain: z.string().default('')
    .description('GitHub Enterprise domain (e.g. company.ghe.com); blank serves github.com')
    .volatile(),
}) as unknown as z<Config>

/** The pi-ai settings namespace as a branded settings-namespace value. */
const PI_AI_NS = COPILOT_SETTINGS_NS as SettingsNamespace

/**
 * Plugin body: register the card namespace, the HTTP gateway, and the
 * status tool. Every host read goes through optional services (`ctx.get`)
 * so a composition without the authorization or credentials seam still
 * boots — the card then reports the missing pieces instead of failing load.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  // rc.1: the namespace-registration API is gone. The plugin declares its
  // editable fields as volatile Cordis config (above) and only records its
  // page policy
  // (`auto: false` — the plugin ships its own card); values persist in the
  // active profile's `cordis.patch.yml` under this entry's id.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const authorization = () => ctx.get('authorization')
  const credentials = () => ctx.get('credentials')

  // The entry's resolved `llm-pi-ai` section, read from the settings service's
  // describe projection (the pi-ai section is owned by dsh-llm-pi-ai, so read
  // it defensively).
  const piAiSection = (): Record<string, unknown> | undefined => {
    const settings = ctx.get('settings')
    if (settings === undefined) return undefined
    const raw = settings.describe().find(row => row.ns === PI_AI_NS)?.value as unknown
    return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  }

  const sources: StatusSources = {
    listFlows: () => authorization()?.list() ?? [],
    describeRecord: async key => credentials()?.describeRecord(key),
    settingsSection: piAiSection,
    models: async () => grantModelIds(await credentials()?.readRecord(COPILOT_RECORD_KEY)),
  }

  /**
   * Minimal structural face of the `llm` service this plugin reads; the full
   * type is deliberately not a dependency for one call.
   */
  interface LlmDiscoveryFace {
    discoverModels(
      settingsNs: string,
      request: { provider?: string },
      signal?: AbortSignal,
    ): Promise<readonly { id: string }[]>
  }

  /**
   * The installed pi-ai catalog for the Copilot route, through the llm
   * service's public discovery — a catalog route answers from the registry
   * with no network call. `undefined` (and a swallowed failure, which would
   * only degrade the models narrowing to the untouched catalog) keeps a
   * composition without the llm seam booting.
   */
  const catalogModels = async (): Promise<readonly { id: string }[] | undefined> => {
    // ctx.get (not a property read): the llm service is a sibling fiber's
    // contribution, and the property proxy resolves along the fiber chain,
    // throwing on an undeclared inject instead of consulting the global store.
    const llm = ctx.get('llm') as LlmDiscoveryFace | undefined
    if (llm === undefined) return undefined
    try {
      return await llm.discoverModels(COPILOT_SETTINGS_NS, { provider: COPILOT_PROVIDER })
    } catch {
      // Discovery is a catalog read for a shipped provider; a throw means the
      // llm seam refused the request shape, and the autofill then writes the
      // minimal profile rather than a narrowed models list.
      return undefined
    }
  }

  ctx.effect(() => registerCopilotGateway(ctx, {
    enterpriseDomain: () => config.enterpriseDomain.get(),
    listFlows: sources.listFlows,
    models: sources.models,
    catalogModels,
    begin: request => {
      const seam = authorization()
      if (seam === undefined) {
        throw new Error('the authorization service is not mounted in this composition')
      }
      return seam.begin(request)
    },
    cancel: key => { authorization()?.cancel(key) },
    describeRecord: sources.describeRecord,
    deleteRecord: key => {
      const seam = credentials()
      if (seam === undefined) {
        throw new Error('the credentials service is not mounted in this composition')
      }
      return seam.deleteRecord(key)
    },
    settingsSection: piAiSection,
    updateSettings: async patch => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error('the settings service is not mounted; the provider profile cannot be activated')
      }
      await settings.update(PI_AI_NS, patch as object)
    },
  }), 'dsh-plugin-copilot: /copilot/api gateway')

  registerCopilotTools(ctx, sources)
}
