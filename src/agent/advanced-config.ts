import { llmConfig } from '@/agent/llm-config'
import { createLlmClient } from '@/connectors/llm.connector'
import { workersAiFetch } from '@/connectors/workers-ai-shim'
import type OpenAI from 'openai'
import { createMemoryStore } from '@/agent/memory/vault-store'
import type { AdvancedSettingsFile } from '@/agent/memory/memory-store'
import type { AdvancedSettingsInput, AdvancedSettingsView, ApiTestResult, Env } from '@/types'

export const KEY_MASK = '****'

/** First 3 and last 4 characters stay visible: enough to recognise a key, not enough to reuse it. */
export function maskApiKey(key: string): string {
  const k = key.trim()
  if (!k) {
    return ''
  }
  if (k.length <= 8) {
    return `${k.slice(0, 1)}${KEY_MASK}${k.slice(-2)}`
  }
  return `${k.slice(0, 3)}${KEY_MASK}${k.slice(-4)}`
}

/** A field that still carries the mask, or is empty, means "unchanged" — the stored secret wins. */
export function mergeApiKey(submitted: string | undefined, existing: string): string {
  if (submitted === undefined) {
    return existing
  }
  const t = submitted.trim()
  if (!t || t.includes(KEY_MASK)) {
    return existing
  }
  return t
}

export function toSettingsView(s: AdvancedSettingsFile): AdvancedSettingsView {
  return {
    soulPrompt: s.soulPrompt,
    customApiEnabled: s.customApiEnabled,
    customBaseUrl: s.customBaseUrl,
    customModel: s.customModel,
    customApiKeyMasked: s.customApiKey ? maskApiKey(s.customApiKey) : undefined,
    customApiKeyConfigured: !!s.customApiKey,
    tavilyApiKeyMasked: s.tavilyApiKey ? maskApiKey(s.tavilyApiKey) : undefined,
    braveApiKeyMasked: s.braveApiKey ? maskApiKey(s.braveApiKey) : undefined,
  }
}

export const EMPTY_ADVANCED: AdvancedSettingsFile = {
  soulPrompt: '',
  customApiEnabled: false,
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  tavilyApiKey: '',
  braveApiKey: '',
}

/** 永不抛出：R2 里没有 advanced.json、字段缺失或读取出错时一律返回默认配置，
 *  上层据此无缝走回部署默认的模型路径。 */
export async function readAdvancedSettings(env: Env): Promise<AdvancedSettingsFile> {
  try {
    return await createMemoryStore(env).getAdvancedSettings()
  } catch (err) {
    console.error('[advanced-config] read failed, using defaults:', err)
    return { ...EMPTY_ADVANCED }
  }
}

export function applyAdvancedInput(
  existing: AdvancedSettingsFile,
  input: AdvancedSettingsInput,
): AdvancedSettingsFile {
  return {
    soulPrompt: (input.soulPrompt ?? existing.soulPrompt).trim(),
    customApiEnabled: input.customApiEnabled ?? existing.customApiEnabled,
    customBaseUrl: (input.customBaseUrl ?? existing.customBaseUrl).trim().replace(/\/$/, ''),
    customApiKey: mergeApiKey(input.customApiKey, existing.customApiKey),
    customModel: (input.customModel ?? existing.customModel).trim(),
    tavilyApiKey: mergeApiKey(input.tavilyApiKey, existing.tavilyApiKey),
    braveApiKey: mergeApiKey(input.braveApiKey, existing.braveApiKey),
  }
}

export interface LlmRoute {
  apiKey: string
  baseUrl: string
  /** Set only when a custom endpoint is in effect; null means the deployment's own model. */
  model: string | null
  custom: boolean
  /** true = the route is served by the env.AI binding (no credentials needed on the account). */
  viaAI?: boolean
}

/** Complete custom config only: a half-filled form must fall back rather than send a turn to a URL
 *  with no key. */
export function customRoute(s: AdvancedSettingsFile): LlmRoute | null {
  if (!s.customApiEnabled) {
    return null
  }
  const baseUrl = s.customBaseUrl.trim().replace(/\/$/, '')
  const apiKey = s.customApiKey.trim()
  const model = s.customModel.trim()
  if (!baseUrl || !apiKey || !model) {
    return null
  }
  return { apiKey, baseUrl, model, custom: true }
}

/** Precedence: enabled web settings > env LLM_BASE_URL/LLM_API_KEY > Workers AI with CF_API_TOKEN. */
export async function resolveLlmRoute(env: Env, settings?: AdvancedSettingsFile): Promise<LlmRoute> {
  const custom = customRoute(settings ?? (await readAdvancedSettings(env)))
  if (custom) {
    return custom
  }
  if (!env.LLM_BASE_URL) {
    // 默认路径直连 env.AI 绑定：不需要 CF_API_TOKEN，也彻底绕开 OpenAI SDK 的凭据校验。
    return { apiKey: '', baseUrl: '', model: env.LLM_MODEL, custom: false, viaAI: true }
  }
  const cfg = llmConfig(env)
  return { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: null, custom: false }
}

/** 硬性规则：Workers AI / HF 模型 ID 只能走 env.AI 绑定，customApiEnabled 与 LLM_BASE_URL 一律
 *  让位——第三方端点不认识这些 ID，路由过去只会得到 404 或连接错误。 */
export function isWorkersAiModel(model: string): boolean {
  return model.startsWith('@cf/') || model.startsWith('@hf/')
}

export function forceViaAiRoute(model: string): LlmRoute {
  return { apiKey: '', baseUrl: '', model, custom: false, viaAI: true }
}

/** 统一的客户端工厂：env.AI 路径走绑定适配器；任何路径都不允许空 Key 触发 SDK 的
 *  Missing credentials 校验。 */
export function clientForRoute(env: Env, route: LlmRoute, doFetch?: typeof fetch, charge?: () => void): OpenAI {
  if (route.viaAI) {
    return createLlmClient(
      'no-key-needed',
      'https://workers-ai.binding/v1',
      workersAiFetch(env, route.model ?? env.LLM_MODEL, charge),
    )
  }
  return createLlmClient(route.apiKey || 'no-key-needed', route.baseUrl, doFetch)
}

export async function testCustomApi(env: Env, input: AdvancedSettingsInput): Promise<ApiTestResult> {
  const existing = await readAdvancedSettings(env)
  const merged = applyAdvancedInput(existing, input)
  const baseUrl = merged.customBaseUrl
  const apiKey = merged.customApiKey
  const model = merged.customModel
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, detail: '请先填写 Base URL、API Key 和 Model ID' }
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      return { ok: true, detail: `连接成功（${model}）` }
    }
    const body = await res.text()
    return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
