/**
 * Model-facing GitHub Copilot login tools. DSH has no CLI auth seam, so the
 * opencode `auth login` flow maps onto two cooperative tools: `copilot_login`
 * starts the device flow and surfaces the verification URL and user code
 * (also persisted as a plugin notice via `deferContext`), and
 * `copilot_login_wait` polls until the user approves — split so no tool
 * blocks while the human is still walking to the browser. `copilot_status`
 * and `copilot_logout` round out account management.
 *
 * @module @huanlin/dsh-plugin-copilot/tools
 */

import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { fetchRemoteModels } from './copilot-models.ts'
import { startDeviceFlow, pollDeviceFlow, DeviceFlowCancelled } from './device-flow.ts'
import { clearStoredAuth, loadStoredAuth, saveStoredAuth } from './auth-store.ts'
import type { StoredCopilotAuth } from './auth-store.ts'
import { copilotBaseUrl, normalizeEnterpriseDomain } from './config.ts'
import type { CopilotConnection } from './config.ts'
import type { ResolvedCopilotAuth } from './adapter.ts'

/** Services the login tools resolve per call. */
export interface CopilotToolDeps {
  /** Current validated connection facts. */
  options: () => CopilotConnection
  /** Per-call bearer resolution (device-flow store, credential-ref fallback). */
  resolveAuth: (connection: CopilotConnection) => Promise<ResolvedCopilotAuth>
}

interface PendingLogin {
  start: Awaited<ReturnType<typeof startDeviceFlow>>
  domain: string
}

const PLUGIN_NAME = 'dsh-plugin-copilot'

/** Loose canonical-JSON output declaration shared by all four tools. */
const JSON_OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: never, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Resolve the deployment domain one login attempt targets. */
function loginDomain(connection: CopilotConnection, enterpriseUrl: string | undefined): string {
  const configured = enterpriseUrl !== undefined && enterpriseUrl.trim().length > 0
    ? normalizeEnterpriseDomain(enterpriseUrl.trim())
    : (connection.enterpriseDomain ?? 'github.com')
  return configured.length > 0 ? configured : 'github.com'
}

/**
 * Register the four tools. One pending login slot lives in this closure:
 * a fresh `copilot_login` overwrites it, and a restart drops it (the user
 * simply starts the flow again — no durable half-logged-in state exists).
 */
export function registerCopilotTools(ctx: Context, deps: CopilotToolDeps): void {
  let pending: PendingLogin | undefined

  ctx.tools.register(defineTool({
    name: 'copilot_login',
    description: 'Start GitHub Copilot login via the OAuth device flow. Returns a verification URL and a '
      + 'user code: show both to the user and ask them to open the URL, enter the code, and approve the '
      + '"GitHub Copilot Request" authorization, then call copilot_login_wait to finish. Safe to call again '
      + 'at any time; a new call invalidates any previous pending login.',
    parameters: {
      enterprise_url: {
        type: 'string',
        description: 'GitHub Enterprise domain or URL (e.g. company.ghe.com). Omit for the public github.com '
          + 'deployment; omission follows the plugin configuration.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const connection = deps.options()
      const domain = loginDomain(connection, args.enterprise_url)
      const start = await startDeviceFlow(domain, connection.clientId)
      pending = { start, domain }
      exec.deferContext(createUserMessage({
        content: [{
          type: 'text',
          text: `GitHub Copilot login pending: open ${start.verificationUri} and enter code ${start.userCode}.`,
        }],
        source: {
          kind: 'plugin',
          plugin: PLUGIN_NAME,
          form: 'notice',
          summary: boundContextSummary(`copilot_login: code ${start.userCode} at ${start.verificationUri}`),
        },
      }))
      return {
        status: 'awaiting_authorization',
        verification_uri: start.verificationUri,
        user_code: start.userCode,
        ...(start.expiresInSeconds !== undefined ? { expires_in_seconds: start.expiresInSeconds } : {}),
        domain,
        next_step: 'Show the URL and code to the user; when they have approved, call copilot_login_wait.',
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'GitHub Copilot login', kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'copilot_login_wait',
    description: 'Wait for the pending GitHub Copilot device-flow login to finish (the user approving in '
      + 'their browser). Call only after copilot_login returned a user code the user has seen. Returns the '
      + 'final login status; an authorized result stores the token and the GitHub Copilot provider is '
      + 'ready on the next request. Cancelling this tool stops waiting without logging out.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      const connection = deps.options()
      if (pending === undefined) {
        return {
          status: 'no_pending_login',
          hint: 'No device-flow login is in progress; call copilot_login first.',
        }
      }
      const { start, domain } = pending
      let outcome
      try {
        outcome = await pollDeviceFlow(start, domain, connection.clientId, exec.signal)
      } catch (error) {
        if (error instanceof DeviceFlowCancelled) {
          return {
            status: 'cancelled',
            hint: 'Waiting was cancelled; the pending code may still be valid — call copilot_login_wait again.',
          }
        }
        throw error
      }
      // Built as a record so optional facts attach only when they exist
      // (canonical JSON values carry no undefined).
      const result: Record<string, JsonValue> = { status: outcome.kind }
      if (outcome.kind === 'authorized') {
        await saveStoredAuth(connection.authFile, {
          version: 1,
          githubToken: outcome.githubToken,
          ...(domain === 'github.com' ? {} : { enterpriseDomain: domain }),
        })
        pending = undefined
        result.domain = domain
        result.stored_at = connection.authFile
        result.note = 'GitHub Copilot is ready; the next model request will use the new token.'
      } else {
        pending = undefined
        if (outcome.kind === 'denied') {
          result.note = 'The user denied the authorization request.'
        } else if (outcome.kind === 'expired') {
          result.note = 'The user code expired; call copilot_login to start over.'
        } else {
          result.message = outcome.message
        }
      }
      return result
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Waiting for Copilot approval', kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'copilot_status',
    description: 'Report the GitHub Copilot provider auth state: whether a token is stored from a device-flow '
      + 'login, where it lives, the deployment domain in use, and — when a token exists — how many models the '
      + 'Copilot API currently lists for the account. Read-only.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      const connection = deps.options()
      let stored: StoredCopilotAuth | undefined
      try {
        stored = await loadStoredAuth(connection.authFile)
      } catch (error) {
        return {
          authenticated: false,
          auth_file: connection.authFile,
          store_error: error instanceof Error ? error.message : String(error),
        }
      }
      if (stored === undefined) {
        let source: 'credential' | 'none' = 'none'
        try {
          await deps.resolveAuth(connection)
          source = 'credential'
        } catch {
          // No credential-ref token either: source stays 'none'.
        }
        const result: Record<string, JsonValue> = {
          authenticated: source === 'credential',
          source,
          auth_file: connection.authFile,
        }
        if (connection.enterpriseDomain !== undefined) result.enterprise_domain = connection.enterpriseDomain
        if (source === 'none') {
          result.hint = `Run copilot_login, or export the ${connection.githubTokenEnv} environment variable.`
        }
        return result
      }
      const domain = stored.enterpriseDomain ?? connection.enterpriseDomain
      const baseURL = copilotBaseUrl(connection.baseURL, domain)
      const result: Record<string, JsonValue> = {
        authenticated: true,
        source: 'device-flow',
        auth_file: connection.authFile,
        api_base: baseURL,
      }
      if (domain !== undefined) result.enterprise_domain = domain
      try {
        const models = await fetchRemoteModels(baseURL, {
          authorization: `Bearer ${stored.githubToken}`,
          'accept': 'application/json',
          'x-github-api-version': connection.apiVersion,
        })
        result.model_count = models.length
      } catch (error) {
        result.probe_error = error instanceof Error ? error.message : String(error)
      }
      return result
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Copilot auth status', kind: 'read' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'copilot_logout',
    description: 'Remove the stored GitHub Copilot token (device-flow login). The provider stops working on '
      + 'the next request unless a credential-ref environment variable (e.g. GITHUB_COPILOT_TOKEN) is '
      + 'configured. Does not revoke the authorization on github.com.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      const connection = deps.options()
      let stored: StoredCopilotAuth | undefined
      try {
        stored = await loadStoredAuth(connection.authFile)
      } catch (error) {
        throw new HarnessError(
          `copilot_logout: stored auth is unreadable (${error instanceof Error ? error.message : String(error)}); `
          + 'remove the auth file manually to proceed.',
          'COPILOT_LOGOUT_UNREADABLE_STORE',
        )
      }
      if (stored === undefined) return { status: 'not_logged_in' }
      await clearStoredAuth(connection.authFile)
      const result: Record<string, JsonValue> = { status: 'cleared' }
      result.auth_file = connection.authFile
      return result
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Copilot logout', kind: 'other' as const }),
  }))
}
