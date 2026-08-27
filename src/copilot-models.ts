/**
 * Copilot model catalog: remote `/models` metadata mapped into the internal
 * {@link CopilotModel} shape (endpoint routing, capability extraction, usable
 * filter) and into harness `LlmModelInfo` / `LlmResolvedModelInfo` values.
 * Selection semantics mirror opencode: picker-enabled models surface in the
 * picker, utility models stay requestable for session titles, and
 * `policy.state: 'disabled'` or missing limits/tool-call capability drop a
 * model from the catalog entirely.
 *
 * @module @harness/dsh-plugin-copilot/models
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmReasoningEffortInfo,
  ModelModality,
} from '@deepseek-ai/dsh-llm'
import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_OUTPUT_TOKENS } from './config.ts'
import type { CopilotConnection } from './config.ts'

/** Wire protocols the Copilot API exposes per model. */
export type CopilotEndpoint = 'chat' | 'responses' | 'messages'

/** The subset of a `/models` item this adapter consumes (tolerant of extras). */
export interface RemoteModel {
  model_picker_enabled?: boolean
  id?: string
  name?: string
  version?: string
  supported_endpoints?: string[]
  policy?: { state?: string }
  capabilities?: {
    family?: string
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
      vision?: { supported_media_types?: string[] }
    }
    supports?: {
      adaptive_thinking?: boolean
      max_thinking_budget?: number
      min_thinking_budget?: number
      reasoning_effort?: string[]
      streaming?: boolean
      structured_outputs?: boolean
      tool_calls?: boolean
      vision?: boolean
    }
  }
}

/** Internal catalog entry for one usable Copilot model. */
export interface CopilotModel {
  /** Catalog key (the remote model id). */
  id: string
  /** Display name. */
  name: string
  /** Capability family reported by the endpoint (gpt, claude, …). */
  family?: string
  /** Wire protocol this model routes to. */
  endpoint: CopilotEndpoint
  /** Whether the endpoint lists the model in the model picker. */
  pickerEnabled: boolean
  /** Combined context capacity, when disclosed. */
  contextWindow?: number
  /** Per-request output cap, when disclosed. */
  maxOutputTokens?: number
  /** Image input accepted (vision capability or image media types). */
  supportsVision: boolean
  /** PDF input accepted (vision media type `application/pdf`). */
  supportsPdf: boolean
  /** Verbatim effort vocabulary when the model is effort-driven (GPT-5 class). */
  reasoningEfforts?: string[]
  /** Thinking budget ceiling when the model is budget-driven (Claude class). */
  maxThinkingBudget?: number
  /** DSH-side effort/budget derivation of {@link CopilotModel.maxThinkingBudget}. */
  thinkingBudgets?: { low: number; high: number; max: number }
}

/** Utility models opencode uses for title generation; picker-excluded but requestable. */
export const UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'] as const

/**
 * Static best-effort catalog for requests made before login (or while the
 * remote listing is unreachable). Intentionally small: the remote `/models`
 * endpoint is the authoritative catalog once a token exists.
 */
export const STATIC_FALLBACK_MODELS: readonly CopilotModel[] = [
  { id: 'gpt-5-mini', name: 'GPT-5 mini', endpoint: 'chat', pickerEnabled: true, contextWindow: 128_000, maxOutputTokens: 16_384, supportsVision: false, supportsPdf: false },
  { id: 'gpt-4.1', name: 'GPT-4.1', endpoint: 'chat', pickerEnabled: true, contextWindow: 128_000, maxOutputTokens: 32_768, supportsVision: false, supportsPdf: false },
  { id: 'gpt-4o', name: 'GPT-4o', endpoint: 'chat', pickerEnabled: true, contextWindow: 128_000, maxOutputTokens: 16_384, supportsVision: true, supportsPdf: false },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', endpoint: 'chat', pickerEnabled: true, contextWindow: 128_000, maxOutputTokens: 16_384, supportsVision: true, supportsPdf: false },
]

/**
 * opencode's Responses-API routing rule: GPT-5 class models (except the mini
 * variants, which still need chat completions) prefer `/responses`.
 */
export function prefersResponsesApi(modelId: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelId)
  return match !== null && Number(match[1]) >= 5 && !modelId.startsWith('gpt-5-mini')
}

/** Endpoint routing: `/v1/messages` first, then `/responses`, then `/chat/completions`; unknown falls to the GPT-5 heuristic. */
export function endpointOf(modelId: string, supportedEndpoints: readonly string[] | undefined): CopilotEndpoint {
  if (supportedEndpoints !== undefined) {
    if (supportedEndpoints.includes('/v1/messages')) return 'messages'
    if (supportedEndpoints.includes('/responses')) return 'responses'
    if (supportedEndpoints.includes('/chat/completions')) return 'chat'
  }
  return prefersResponsesApi(modelId) ? 'responses' : 'chat'
}

/** opencode's usable filter: disabled policy or missing limits/capability drops the model. */
export function isUsableRemote(item: RemoteModel): boolean {
  return item.id !== undefined
    && item.policy?.state !== 'disabled'
    && item.capabilities?.limits?.max_output_tokens !== undefined
    && item.capabilities?.limits.max_prompt_tokens !== undefined
    && item.capabilities.supports?.tool_calls !== undefined
}

/** Map one usable remote item to the internal catalog entry. */
export function buildModel(item: RemoteModel): CopilotModel {
  const id = item.id as string
  const supports = item.capabilities?.supports ?? {}
  const limits = item.capabilities?.limits
  const mediaTypes = limits?.vision?.supported_media_types ?? []
  const supportsVision = (supports.vision ?? false) || mediaTypes.some(type => type.startsWith('image/'))
  const supportsPdf = (supports.vision ?? false) && mediaTypes.includes('application/pdf')
  const efforts = supports.reasoning_effort?.filter(effort => typeof effort === 'string' && effort.length > 0)
  const budgets = typeof supports.max_thinking_budget === 'number' && supports.max_thinking_budget > 1
    ? supports.max_thinking_budget
    : undefined
  const isEffortDriven = efforts !== undefined && efforts.length > 0
  return {
    id,
    name: item.name ?? id,
    ...item.capabilities?.family !== undefined ? { family: item.capabilities.family } : {},
    endpoint: endpointOf(id, item.supported_endpoints),
    pickerEnabled: item.model_picker_enabled === true,
    ...limits?.max_context_window_tokens !== undefined || limits?.max_prompt_tokens !== undefined
      ? { contextWindow: limits.max_context_window_tokens ?? limits.max_prompt_tokens }
      : {},
    maxOutputTokens: limits?.max_output_tokens,
    supportsVision,
    supportsPdf,
    ...isEffortDriven ? { reasoningEfforts: [...efforts] } : {},
    ...budgets !== undefined ? { maxThinkingBudget: budgets } : {},
    ...!isEffortDriven && budgets !== undefined
      ? {
        thinkingBudgets: {
          low: Math.floor(budgets / 4),
          high: Math.floor(budgets / 2),
          max: budgets - 1,
        },
      }
      : {},
  }
}

/** `/models` response envelope. */
export interface RemoteModelCatalog {
  data?: RemoteModel[]
}

/** Fetch the remote catalog with the headers one authenticated request carries. */
export async function fetchRemoteModels(
  baseURL: string,
  headers: Record<string, string>,
  timeoutMs = 5_000,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotModel[]> {
  const response = await fetchImpl(`${baseURL}/models`, {
    headers: { ...headers, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Copilot /models request failed with HTTP ${response.status}`)
  }
  const body = await response.json() as RemoteModelCatalog
  const data = Array.isArray(body.data) ? body.data : []
  return data.filter(isUsableRemote).map(buildModel)
}

/**
 * Catalog selection for harness surfaces: picker-enabled models plus the
 * utility models (which stay requestable for session titles even though the
 * endpoint hides them from its picker).
 */
export function selectableModels(catalog: readonly CopilotModel[]): CopilotModel[] {
  const utilities = new Set<string>(UTILITY_MODELS)
  return catalog.filter(model => model.pickerEnabled || utilities.has(model.id))
}

/** Modality declaration for one model: image input only when the model says so. */
function modalities(model: CopilotModel): readonly ModelModality[] {
  return model.supportsVision ? ['text', 'image'] : ['text']
}

/** Map catalog entries to advisory `LlmModelInfo` values. */
export function toModelInfos(provider: string, catalog: readonly CopilotModel[]): LlmModelInfo[] {
  return selectableModels(catalog).map(model => ({
    provider,
    id: model.id,
    name: model.name,
    ...model.family !== undefined ? { description: `${model.family} family` } : {},
    inputModalities: modalities(model),
  }))
}

/** Effort list for one model: verbatim effort vocabulary, or budget-derived levels. */
function effortsOf(model: CopilotModel, connection: CopilotConnection): LlmReasoningEffortInfo[] | undefined {
  if (model.reasoningEfforts !== undefined) {
    return model.reasoningEfforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort }))
  }
  if (model.thinkingBudgets !== undefined) {
    return [
      { id: ReasoningEffortId('off'), name: 'Off' },
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
      { id: ReasoningEffortId('max'), name: 'Max' },
    ]
  }
  return undefined
}

/**
 * Exact-route metadata for one model. Unknown models resolve with the
 * fallback capacities and text-only input (declaring an unverified image
 * capability would let the host persist input the endpoint may reject).
 */
export function toResolvedModel(
  provider: string,
  model: CopilotModel | undefined,
  modelId: string,
  connection: CopilotConnection,
): LlmResolvedModelInfo {
  const efforts = model === undefined ? undefined : effortsOf(model, connection)
  const defaultEffort = efforts !== undefined
    && connection.defaultReasoningEffort !== undefined
    && efforts.some(entry => entry.id === connection.defaultReasoningEffort)
      ? ReasoningEffortId(connection.defaultReasoningEffort)
      : undefined
  return {
    provider,
    id: modelId,
    name: model?.name ?? modelId,
    ...(model === undefined ? { inputModalities: ['text' as const] } : { inputModalities: modalities(model) }),
    context: { contextWindow: model?.contextWindow ?? FALLBACK_CONTEXT_WINDOW },
    defaultMaxTokens: model?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS,
    ...(efforts === undefined ? {} : {
      reasoning: {
        efforts,
        ...defaultEffort === undefined ? {} : { defaultEffort },
      },
    }),
  }
}
