/**
 * `CopilotAdapter`: fetch + SSE against the GitHub Copilot API, emitting
 * harness StreamChunks. One instance serves the whole `github-copilot`
 * provider route; the wire protocol per request follows the model's routed
 * endpoint (`/v1/messages`, `/responses`, or `/chat/completions`).
 *
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the GitHub bearer through a per-request
 * resolver, so the registering plugin owns validation, layering, and
 * credential policy (device-flow store, credential-ref fallback).
 *
 * @module @huanlin/dsh-plugin-copilot/adapter
 */

import { attributionHeaders, contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { copilotBaseUrl } from './config.ts'
import type { CopilotConnection } from './config.ts'
import { STATIC_FALLBACK_MODELS, endpointOf, fetchRemoteModels, toModelInfos, toResolvedModel } from './copilot-models.ts'
import type { CopilotModel } from './copilot-models.ts'
import { initiatorOf, requestHeaders } from './headers.ts'
import { httpError, parseSseEvents } from './wire/shared.ts'
import { serializeChatRequest, translateChat } from './wire/chat.ts'
import type { ImageResolutionOptions } from './wire/chat.ts'
import { serializeResponsesRequest, translateResponses } from './wire/responses.ts'
import { serializeMessagesRequest, translateMessages } from './wire/messages.ts'

/** Watchdog code distinguishing a stalled provider stream from other failures. */
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** The bearer-token resolution the plugin owns, per request. */
export interface ResolvedCopilotAuth {
  /** GitHub OAuth token sent as the Copilot API bearer. */
  token: string
  /**
   * Deployment domain the token belongs to (enterprise only); the token's
   * domain wins over configured facts so a login pins its own deployment.
   */
  enterpriseDomain?: string
  /** Where the token came from, for diagnostics. */
  source: 'device-flow' | 'credential'
}

/** Constructor options for {@link CopilotAdapter}: the operation-local resolution hooks the plugin owns. */
export interface CopilotAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CopilotConnection
  /**
   * Resolve the GitHub bearer for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the endpoint and the secret
   * sent to it always come from the same resolution generation. Throws
   * `LlmError` `MISSING_CREDENTIAL` when no token is available anywhere.
   */
  resolveAuth: (connection: CopilotConnection) => Promise<ResolvedCopilotAuth>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments: () => AttachmentStore | undefined
  /** Injectable transport for offline tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Effective API base: an explicit override wins, then the token's domain, then config. */
function effectiveBase(connection: CopilotConnection, auth: ResolvedCopilotAuth): string {
  return copilotBaseUrl(connection.baseURL, auth.enterpriseDomain ?? connection.enterpriseDomain)
}

/** The lightweight header set the catalog fetch carries (no stream accept header). */
function catalogHeaders(connection: CopilotConnection, auth: ResolvedCopilotAuth): Record<string, string> {
  return {
    'authorization': `Bearer ${auth.token}`,
    'accept': 'application/json',
    'x-github-api-version': connection.apiVersion,
    ...attributionHeaders(),
  }
}

/**
 * The Copilot provider adapter. One stable signal reaches both initial fetch
 * and body reads; caller aborts map to `ABORTED`, the configured per-read
 * idle watchdog maps to `TIMEOUT`.
 */
export class CopilotAdapter extends LlmAdapter {
  private cache: { models: readonly CopilotModel[]; fetchedAt: number } | undefined
  private ongoingRefresh: Promise<readonly CopilotModel[]> | undefined

  constructor(private readonly config: CopilotAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'GitHub Copilot' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  /**
   * Advisory model catalog: picker-enabled plus utility models from the
   * remote listing, or the static fallback when no token exists yet or the
   * endpoint is unreachable. Never throws — an advisory catalog must not
   * break a lookup.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.catalogOrFallback()
    return toModelInfos(provider, models)
  }

  /** Exact-route metadata from the latest catalog snapshot (fallback capacities for unknown ids). */
  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const models = await this.catalogOrFallback()
    return toResolvedModel(provider, models.find(entry => entry.id === model), model, connection)
  }

  /** Fresh-or-stale catalog snapshot; refreshes in the background when stale. */
  private async catalogOrFallback(): Promise<readonly CopilotModel[]> {
    const connection = this.config.options()
    const cached = this.cache
    if (cached !== undefined && cached.models.length > 0
      && Date.now() - cached.fetchedAt < connection.modelsRefreshMs) {
      return cached.models
    }
    try {
      return await this.refreshCatalog(connection)
    } catch {
      // Unauthenticated or unreachable: last good catalog beats the static fallback.
      if (cached !== undefined && cached.models.length > 0) return cached.models
      return STATIC_FALLBACK_MODELS
    }
  }

  private async refreshCatalog(connection: CopilotConnection): Promise<readonly CopilotModel[]> {
    const existing = this.ongoingRefresh
    if (existing !== undefined) return existing
    const promise = this.doRefreshCatalog(connection).finally(() => {
      if (this.ongoingRefresh === promise) this.ongoingRefresh = undefined
    })
    this.ongoingRefresh = promise
    return promise
  }

  private async doRefreshCatalog(connection: CopilotConnection): Promise<readonly CopilotModel[]> {
    const auth = await this.config.resolveAuth(connection)
    const models = await fetchRemoteModels(
      effectiveBase(connection, auth),
      catalogHeaders(connection, auth),
      5_000,
      this.config.fetchImpl,
    )
    if (models.length > 0) this.cache = { models, fetchedAt: Date.now() }
    return models.length > 0 ? models : (this.cache?.models ?? STATIC_FALLBACK_MODELS)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the bearer freeze
    // here and hold for this whole request, so an in-flight stream never
    // observes a configuration change and the next call re-resolves.
    const connection = this.config.options()
    const auth = await this.config.resolveAuth(connection)
    const vision = options.messages.some(message => contentHasImage(message.content))
    let images: ImageResolutionOptions | undefined
    if (vision) {
      const attachments = this.config.resolveAttachments()
      if (attachments === undefined) {
        throw new LlmError('Copilot image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
      }
      images = { attachments, signal: options.signal ?? new AbortController().signal, maxImageBytes: connection.maxRequestImageBytes }
    }
    const model = this.cache?.models.find(entry => entry.id === options.model)
    const baseURL = effectiveBase(connection, auth)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, auth, model, baseURL, images, vision, () => {
      watchdog.pulse()
    })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Copilot stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Copilot request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Copilot API stream from ${baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Copilot stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async *request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CopilotConnection,
    auth: ResolvedCopilotAuth,
    model: CopilotModel | undefined,
    baseURL: string,
    images: ImageResolutionOptions | undefined,
    vision: boolean,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const endpoint = model?.endpoint ?? endpointOf(options.model, undefined)
    const [body, url] = await serializeFor(endpoint, options, model, images, baseURL)
    const headers = requestHeaders(connection, {
      token: auth.token,
      endpoint,
      vision,
      initiator: initiatorOf(options),
      ...options.purpose !== undefined ? { purpose: options.purpose } : {},
    })

    let response: Response
    try {
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      throw new LlmError(
        `Copilot API request to ${baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }
    if (!response.ok) throw await httpError(response)
    if (!response.body) {
      throw new LlmError('Copilot API returned no response body', 'EMPTY_RESPONSE')
    }

    if (endpoint === 'chat') {
      yield* translateChat(parseSseEvents(response.body, onActivity))
    } else if (endpoint === 'responses') {
      yield* translateResponses(parseSseEvents(response.body, onActivity))
    } else {
      yield* translateMessages(parseSseEvents(response.body, onActivity))
    }
  }
}

/** Serialize one request body and its URL for the routed endpoint. */
async function serializeFor(
  endpoint: 'chat' | 'responses' | 'messages',
  options: GenerateOptions,
  model: CopilotModel | undefined,
  images: ImageResolutionOptions | undefined,
  baseURL: string,
): Promise<[object, string]> {
  if (endpoint === 'chat') {
    return [await serializeChatRequest(options, model, images), `${baseURL}/chat/completions`]
  }
  if (endpoint === 'responses') {
    return [await serializeResponsesRequest(options, model, images), `${baseURL}/responses`]
  }
  return [await serializeMessagesRequest(options, model, images), `${baseURL}/v1/messages`]
}
