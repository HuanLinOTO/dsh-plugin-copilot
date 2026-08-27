/** Model-catalog unit tests: endpoint routing, usable filter, capability mapping. */

import { describe, expect, it, vi } from 'vitest'
import {
  buildModel,
  endpointOf,
  fetchRemoteModels,
  isUsableRemote,
  prefersResponsesApi,
  selectableModels,
  STATIC_FALLBACK_MODELS,
  toModelInfos,
  toResolvedModel,
} from '../src/copilot-models.ts'
import type { RemoteModel } from '../src/copilot-models.ts'
import { resolveConnection } from '../src/config.ts'

function remote(overrides: Partial<RemoteModel>): RemoteModel {
  return {
    id: 'test-model',
    name: 'Test Model',
    model_picker_enabled: true,
    supported_endpoints: ['/chat/completions'],
    policy: { state: 'enabled' },
    capabilities: {
      family: 'gpt',
      limits: {
        max_context_window_tokens: 400_000,
        max_output_tokens: 64_000,
        max_prompt_tokens: 272_000,
      },
      supports: { tool_calls: true, streaming: true },
    },
    ...overrides,
  }
}

describe('endpoint routing (opencode parity)', () => {
  it('routes /v1/messages first', () => {
    expect(endpointOf('claude-x', ['/responses', '/v1/messages', '/chat/completions'])).toBe('messages')
  })
  it('routes /responses next', () => {
    expect(endpointOf('gpt-5.1', ['/responses', '/chat/completions'])).toBe('responses')
  })
  it('routes /chat/completions last', () => {
    expect(endpointOf('o3-mini', ['/chat/completions'])).toBe('chat')
  })
  it('falls back to the gpt-5 heuristic with no endpoint list', () => {
    expect(endpointOf('gpt-5.1', undefined)).toBe('responses')
    expect(endpointOf('gpt-5-mini', undefined)).toBe('chat')
    expect(endpointOf('gpt-4o', undefined)).toBe('chat')
    expect(endpointOf('claude-sonnet-4', undefined)).toBe('chat')
  })
  it('matches opencode shouldUseResponsesApi exactly', () => {
    expect(prefersResponsesApi('gpt-5')).toBe(true)
    expect(prefersResponsesApi('gpt-5.1')).toBe(true)
    expect(prefersResponsesApi('gpt-5-mini')).toBe(false)
    expect(prefersResponsesApi('gpt-4.1')).toBe(false)
    expect(prefersResponsesApi('o4-mini')).toBe(false)
  })
})

describe('usable filter', () => {
  it('drops disabled policy and missing limits/capabilities', () => {
    expect(isUsableRemote(remote({}))).toBe(true)
    expect(isUsableRemote(remote({ policy: { state: 'disabled' } }))).toBe(false)
    expect(isUsableRemote(remote({
      capabilities: { family: 'gpt', limits: { max_prompt_tokens: 1 }, supports: {} },
    }))).toBe(false)
    expect(isUsableRemote(remote({
      capabilities: {
        family: 'gpt',
        limits: { max_output_tokens: 1, max_prompt_tokens: 1 },
        supports: {},
      },
    }))).toBe(false)
  })
})

describe('buildModel', () => {
  it('extracts limits, family, and picker flag', () => {
    const model = buildModel(remote({}))
    expect(model).toMatchObject({
      id: 'test-model',
      name: 'Test Model',
      family: 'gpt',
      endpoint: 'chat',
      pickerEnabled: true,
      contextWindow: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: false,
    })
  })

  it('falls back context to max_prompt_tokens', () => {
    const model = buildModel(remote({
      capabilities: {
        family: 'gpt',
        limits: { max_output_tokens: 8_192, max_prompt_tokens: 200_000 },
        supports: { tool_calls: false },
      },
    }))
    expect(model.contextWindow).toBe(200_000)
  })

  it('detects vision from supports.vision and media types', () => {
    expect(buildModel(remote({
      capabilities: {
        family: 'gpt',
        limits: {
          max_output_tokens: 1,
          max_prompt_tokens: 1,
          vision: { supported_media_types: ['image/png', 'application/pdf'] },
        },
        supports: { tool_calls: true, vision: true },
      },
    }))).toMatchObject({ supportsVision: true, supportsPdf: true })
  })

  it('carries the verbatim effort list for effort-driven models', () => {
    const model = buildModel(remote({
      capabilities: {
        family: 'gpt',
        limits: { max_output_tokens: 1, max_prompt_tokens: 1 },
        supports: { tool_calls: true, reasoning_effort: ['low', 'medium', 'high'] },
      },
    }))
    expect(model.reasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(model.thinkingBudgets).toBeUndefined()
  })

  it('derives budget levels for budget-driven models', () => {
    const model = buildModel(remote({
      id: 'claude-opus',
      capabilities: {
        family: 'claude',
        limits: { max_output_tokens: 1, max_prompt_tokens: 1 },
        supports: { tool_calls: true, adaptive_thinking: true, max_thinking_budget: 8_192 },
      },
    }))
    expect(model.thinkingBudgets).toEqual({ low: 2_048, high: 4_096, max: 8_191 })
    expect(model.reasoningEfforts).toBeUndefined()
  })
})

describe('selectable models', () => {
  it('keeps picker-enabled models and appends utility models only', () => {
    const catalog = [
      buildModel(remote({ id: 'picker-model', model_picker_enabled: true })),
      buildModel(remote({ id: 'gpt-4o', model_picker_enabled: false })),
      buildModel(remote({ id: 'hidden-model', model_picker_enabled: false })),
    ]
    const ids = selectableModels(catalog).map(model => model.id)
    expect(ids).toContain('picker-model')
    expect(ids).toContain('gpt-4o')
    expect(ids).not.toContain('hidden-model')
  })

  it('maps picker+utility models to LlmModelInfo with modality declaration', () => {
    const catalog = [
      buildModel(remote({ id: 'vision-model', capabilities: {
        family: 'gpt',
        limits: { max_output_tokens: 1, max_prompt_tokens: 1 },
        supports: { tool_calls: true, vision: true },
      } })),
      buildModel(remote({ id: 'gpt-4o-mini', model_picker_enabled: false })),
    ]
    const infos = toModelInfos('github-copilot', catalog)
    expect(infos.map(info => info.id)).toEqual(['vision-model', 'gpt-4o-mini'])
    expect(infos[0]?.inputModalities).toEqual(['text', 'image'])
    expect(infos[1]?.inputModalities).toEqual(['text'])
  })
})

describe('toResolvedModel', () => {
  const connection = resolveConnection({})
  it('resolves exact metadata with effort lists and the configured default', () => {
    const model = buildModel(remote({
      capabilities: {
        family: 'gpt',
        limits: { max_context_window_tokens: 400_000, max_output_tokens: 64_000, max_prompt_tokens: 1 },
        supports: { tool_calls: true, reasoning_effort: ['low', 'high'] },
      },
    }))
    const resolved = toResolvedModel('github-copilot', model, 'test-model', {
      ...connection,
      defaultReasoningEffort: 'low',
    })
    expect(resolved.context).toEqual({ contextWindow: 400_000 })
    expect(resolved.defaultMaxTokens).toBe(64_000)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('low')
  })

  it('falls back to safe capacities for unknown ids (text-only)', () => {
    const resolved = toResolvedModel('github-copilot', undefined, 'unknown-model', connection)
    expect(resolved.context?.contextWindow).toBe(128_000)
    expect(resolved.defaultMaxTokens).toBe(16_384)
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.reasoning).toBeUndefined()
  })
})

describe('fetchRemoteModels', () => {
  it('fetches, filters, and maps the remote catalog', async () => {
    const payload = {
      data: [
        remote({ id: 'good' }),
        remote({ id: 'disabled', policy: { state: 'disabled' } }),
        { id: 'garbage' },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    try {
      const models = await fetchRemoteModels('https://api.githubcopilot.com', { authorization: 'Bearer t' })
      expect(models.map(model => model.id)).toEqual(['good'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    try {
      await expect(fetchRemoteModels('https://api.githubcopilot.com', {})).rejects.toThrow(/401/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('static fallback', () => {
  it('is non-empty and chat-routed', () => {
    expect(STATIC_FALLBACK_MODELS.length).toBeGreaterThan(0)
    for (const model of STATIC_FALLBACK_MODELS) {
      expect(model.endpoint).toBe('chat')
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })
})
