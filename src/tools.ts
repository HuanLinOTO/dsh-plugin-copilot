/**
 * Model-facing Copilot status tool. Login interaction belongs to the WebUI
 * card; this tool only reports the onboarding state so an agent can answer
 * "am I signed in to Copilot?" without touching credentials.
 *
 * @module @huanlin/dsh-plugin-copilot/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { joinStatus, COPILOT_SETTINGS_NS } from './status.ts'
import type { StatusSources } from './status.ts'

/**
 * Local structural equivalent of the `JsonValue` type from
 * `@deepseek-ai/dsh-util-values` (dsh 0.1.2-alpha.2 stopped re-exporting it
 * from `@deepseek-ai/dsh-tools`).
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Loose canonical-JSON output declaration. */
const JSON_OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: never, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/**
 * Register the status tool.
 * @param ctx - host plugin context carrying `ctx.tools`.
 * @param sources - the live host reads the status join uses.
 */
export function registerCopilotTools(ctx: Context, sources: StatusSources): void {
  ctx.tools.register(defineTool({
    name: 'copilot_status',
    description: 'Report the GitHub Copilot onboarding state: whether the pi-ai authorization flow is'
      + ' registered, whether a credential record is stored (signed in), whether the llm-pi-ai'
      + ' settings section activates the github-copilot provider route, and which model ids the'
      + ' signed-in account can use. Read-only. Signing in is a'
      + ' WebUI action: Settings → Plugins → GitHub Copilot.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      const status = await joinStatus(sources)
      const result: Record<string, JsonValue> = {
        flow_available: status.flowAvailable,
        signed_in: status.loggedIn,
        profile_activated: status.profileActivated,
        login_in_flight: status.inFlight,
      }
      if (!status.flowAvailable) {
        result.hint = 'dsh-llm-pi-ai with the github-copilot catalog provider is required for Copilot sign-in.'
      } else if (!status.loggedIn) {
        result.hint = 'Sign in from the WebUI: Settings → Plugins → GitHub Copilot → Sign in.'
      } else if (!status.profileActivated) {
        result.hint = `Signed in but the route is dormant; the settings card can activate it (writes ${COPILOT_SETTINGS_NS}.providers.github-copilot).`
      }
      if (status.models !== undefined) result.available_models = [...status.models]
      return result
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Copilot auth status', kind: 'read' as const }),
  }))
}
