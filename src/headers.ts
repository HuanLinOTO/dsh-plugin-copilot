/**
 * Per-request header computation, mirroring the Copilot-specific headers
 * opencode injects: `x-initiator` (agent- vs user-initiated), the
 * conversation-edits intent, the pinned GitHub API version, the vision
 * opt-in, the session-title interaction type, and the interleaved-thinking
 * beta on the Anthropic shim. Every outbound request also carries the
 * harness `attributionHeaders()` (a mandatory adapter contract).
 *
 * @module @huanlin/dsh-plugin-copilot/headers
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { CopilotConnection } from './config.ts'
import type { CopilotEndpoint } from './copilot-models.ts'

/** Who the request is for: `agent` for harness-internal or tool-continuation turns. */
export type CopilotInitiator = 'agent' | 'user'

/**
 * opencode's initiator heuristic, mapped onto the harness request: auxiliary
 * purposes (compaction, session titles) are agent-initiated, and so is a turn
 * whose last message carries no user-visible content — the harness rides tool
 * results inside user messages, so a tool-result-only trailing user message
 * is a tool continuation (opencode's Messages-API branch treats it the same
 * way). An ordinary prompt is user-initiated.
 */
export function initiatorOf(options: GenerateOptions): CopilotInitiator {
  if (options.purpose !== undefined) return 'agent'
  const last = options.messages.at(-1)
  if (last === undefined || last.role !== 'user') return 'agent'
  const hasUserContent = last.content.some(block => block.type !== 'tool-result')
  return hasUserContent ? 'user' : 'agent'
}

/** Inputs to {@link requestHeaders} beyond the connection facts. */
export interface HeaderInputs {
  /** GitHub OAuth bearer token (device-flow or credential-ref source). */
  token: string
  /** Per-request endpoint, for the Anthropic-shim-only headers. */
  endpoint: CopilotEndpoint
  /** Whether any request message carries image input. */
  vision: boolean
  /** agent- vs user-initiated classification (see {@link initiatorOf}). */
  initiator: CopilotInitiator
  /** Harness auxiliary-purpose classification, when present. */
  purpose?: 'compaction' | 'session-title'
}

/** The exact header set for one Copilot request. */
export function requestHeaders(connection: CopilotConnection, inputs: HeaderInputs): Record<string, string> {
  const headers: Record<string, string> = {
    'authorization': `Bearer ${inputs.token}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'x-github-api-version': connection.apiVersion,
    'openai-intent': 'conversation-edits',
    'x-initiator': inputs.initiator,
    ...attributionHeaders(),
  }
  if (inputs.vision) headers['copilot-vision-request'] = 'true'
  if (inputs.purpose === 'session-title') headers['x-interaction-type'] = 'agent-session-name-generation'
  if (inputs.endpoint === 'messages') {
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  }
  return headers
}
