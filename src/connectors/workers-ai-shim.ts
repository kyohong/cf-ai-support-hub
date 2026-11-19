import type { ChatMessage, Env } from '@/types'

interface AiToolCallShape {
  id?: string
  name?: string
  arguments?: unknown
  function?: { name?: string; arguments?: unknown }
}

interface AiChoice {
  message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }
  finish_reason?: string | null
}

interface AiChatResult {
  choices?: AiChoice[]
  response?: unknown
  reasoning_content?: unknown
  tool_calls?: unknown
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ChatRequestBody {
  messages: ChatMessage[]
  tools?: unknown[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
}

interface NormalizedToolCall {
  index: number
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const FALLBACK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const encoder = new TextEncoder()

/** null / undefined / 字面量 "null" 一律视为空文本。 */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.trim()
  return trimmed === 'null' || trimmed === 'undefined' ? '' : trimmed
}

/** 文本优先级：choices[0].message.content → response → reasoning_content 两处。 */
function resultText(res: AiChatResult): string {
  const message = res.choices?.[0]?.message
  return (
    cleanText(message?.content) ||
    cleanText(res.response) ||
    cleanText(message?.reasoning_content) ||
    cleanText(res.reasoning_content)
  )
}

/** 工具调用的两种形态（绑定原生 / OpenAI 形状）统一成 100% 合规的 OpenAI 格式。 */
function normalizeToolCalls(raw: unknown): NormalizedToolCall[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map((entry, index) => {
    const call = entry as AiToolCallShape
    const args = call.function?.arguments ?? call.arguments
    return {
      index,
      id: call.id || `call_${index}`,
      type: 'function' as const,
      function: {
        name: call.function?.name ?? call.name ?? 'unknown',
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    }
  })
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed === 'null' || trimmed === 'undefined' ? '' : content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        const value = (part as { text?: unknown; content?: unknown } | null)?.text
        if (typeof value === 'string') {
          return value
        }
        return JSON.stringify(part)
      })
      .join('\n')
  }
  if (typeof content === 'string') {
    return content
  }
  return JSON.stringify(content)
}

/** env.AI 的 chat schema 只认 string content 与标准角色：tool → user，tool_calls 从属性里剔除
 *  （不传 tools 时带着它会直接校验失败），正文里用标记保留语义。 */
export function normalizeMessages(messages: ChatRequestBody['messages']): Array<{ role: string; content: string }> {
  return (messages ?? []).map((msg) => {
    const rawRole = (msg as { role: string }).role
    let role = rawRole === 'developer' ? 'system' : rawRole
    let content = flattenContent(msg.content)
    if (role === 'tool') {
      role = 'user'
      content = `[Tool Result]: ${content}`
    }
    if (role === 'assistant') {
      const calls = (msg as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
      if (Array.isArray(calls) && calls.length) {
        content = content || `[Executed tools: ${calls.map((c) => c.function?.name ?? 'tool').join(', ')}]`
      }
    }
    return { role, content }
  })
}

function usageOf(res: AiChatResult): { prompt_tokens: number; completion_tokens: number } | undefined {
  if (!res.usage) {
    return undefined
  }
  return {
    prompt_tokens: res.usage.prompt_tokens ?? 0,
    completion_tokens: res.usage.completion_tokens ?? 0,
  }
}

/** 非流式响应：finish_reason 永远显式给出，SDK 不会读到 null。 */
function completionBody(model: string, text: string, toolCalls: NormalizedToolCall[], usage: ReturnType<typeof usageOf>) {
  return {
    id: 'chatcmpl-cf',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
    ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
  }
}

/** 三帧标准 SSE：内容帧（finish_reason: null）→ 强制收尾帧（finish_reason 非 null）→ [DONE]。
 *  收尾帧同时携带 usage，既满足 include_usage 计量，又保持帧数不变。 */
function sseBody(
  model: string,
  text: string,
  toolCalls: NormalizedToolCall[],
  usage: ReturnType<typeof usageOf>,
): string {
  const created = Math.floor(Date.now() / 1000)
  const head = { id: 'chatcmpl-cf', object: 'chat.completion.chunk', created, model }
  const delta = toolCalls.length
    ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
    : { role: 'assistant', content: text }
  const contentFrame = {
    ...head,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
  const finishFrame = {
    ...head,
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
  }
  return `data: ${JSON.stringify(contentFrame)}\n\ndata: ${JSON.stringify(finishFrame)}\n\ndata: [DONE]\n\n`
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/**
 * OpenAI SDK ↔ `env.AI` binding adapter.
 *
 * 内部**永远**以非流式调用绑定：Workers AI 各模型的原生 SSE 流缺 finish_reason、缺
 * tool_calls.index、甚至整段空 chunk（glm-4.7-flash），任何透传都会让 SDK 抛
 * "missing finish_reason for choice 0" / "request ended without sending any chunks"。
 * 这里一律拿完整结果，再合成 100% 合规的 OpenAI 响应（流式则是三帧标准 SSE）。
 *
 * 空结果兜底链：原模型 → 去 tools + max_tokens 2048 重试 → llama-3.3-70b 兜底 → 静态提示，
 * 用户端永远拿得到非空回答。
 */
export function workersAiFetch(env: Env, model: string, charge?: () => void): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: 'not supported by the workers-ai binding adapter' }), {
        status: 404,
      })
    }
    charge?.()
    const body = (await request.json()) as ChatRequestBody
    const wantsStream = body.stream === true
    const messages = normalizeMessages(body.messages)
    const maxTokens = Math.max(body.max_tokens ?? 2048, 2048)
    const base: Record<string, unknown> = {
      messages,
      max_tokens: maxTokens,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.6,
      top_p: typeof body.top_p === 'number' ? body.top_p : 0.95,
    }
    const toolSpec = body.tools?.length ? body.tools : undefined

    const call = async (modelId: string, payload: Record<string, unknown>): Promise<AiChatResult> =>
      (await env.AI.run(modelId, payload as never)) as AiChatResult

    let result = await call(model, toolSpec ? { ...base, tools: toolSpec } : base)
    let text = resultText(result)
    let toolCalls = normalizeToolCalls(result.choices?.[0]?.message?.tool_calls ?? result.tool_calls)

    if (!text && !toolCalls.length) {
      console.error('[workers-ai-shim] empty result, retrying without tools:', model)
      result = await call(model, { ...base, max_tokens: 2048 })
      text = resultText(result)
      toolCalls = normalizeToolCalls(result.choices?.[0]?.message?.tool_calls ?? result.tool_calls)
    }

    if (!text && !toolCalls.length) {
      console.error('[workers-ai-shim] still empty, falling back to', FALLBACK_MODEL)
      result = await call(FALLBACK_MODEL, { ...base, max_tokens: 2048 })
      text = resultText(result)
      toolCalls = normalizeToolCalls(result.choices?.[0]?.message?.tool_calls ?? result.tool_calls)
    }

    if (!text && !toolCalls.length) {
      text = `(no answer produced — the model ${model} returned no text. Try rephrasing or switching models.)`
    }

    const usage = usageOf(result)
    if (!wantsStream) {
      return new Response(JSON.stringify(completionBody(model, text, toolCalls, usage)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(textStream(sseBody(model, text, toolCalls, usage)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    })
  }
}
