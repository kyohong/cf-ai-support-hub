import { chatCompletionWithTools } from '@/connectors/llm.connector'
import { clientForRoute, resolveLlmRoute } from '@/agent/advanced-config'
import { addConversation, addLead, listKnowledge, listMemories, markLeadNotified, recentConversations, type BotRow, type KnowledgeRow, type MemoryRow } from '@/widget/db'
import { extractMemories, renderMemoryBlock, MEMORY_INJECT_LIMIT } from '@/widget/memories'
import { buildQrCodeMarkdown, convertCurrency, getWorldTime, readWebpageMarkdown } from '@/tools/builtin-free-tools'
import type { ChatMessage, Env } from '@/types'

const MAX_TOOL_ROUNDS = 3
const HISTORY_TURNS = 10
const MAX_KB_CONTEXT = 5
const FULL_KB_THRESHOLD = 15
const LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'capture_customer_lead',
    description:
      'Save the visitor’s contact details when they share an email, WhatsApp number, phone or WeChat. Call this exactly once per contact.',
    parameters: {
      type: 'object',
      properties: {
        contact_info: { type: 'string', description: 'The email / WhatsApp / phone / WeChat the visitor gave' },
        inquiry_summary: { type: 'string', description: 'What the visitor wants, in one or two sentences' },
      },
      required: ['contact_info', 'inquiry_summary'],
      additionalProperties: false,
    },
  },
}

const READ_PAGE_TOOL = {
  type: 'function',
  function: {
    name: 'read_webpage',
    description:
      'Read a public product or policy page the visitor linked as clean Markdown (no API key). Use it before quoting specs from a URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Public http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
}

const CURRENCY_TOOL = {
  type: 'function',
  function: {
    name: 'get_exchange_rate',
    description:
      'Convert an amount between currencies using live ECB reference rates. Use it when the visitor asks for a price in another currency.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source currency code, e.g. USD' },
        to: { type: 'string', description: 'Target currency code, e.g. CNY' },
        amount: { type: 'number', description: 'Amount to convert' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
}

const WORLD_TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_world_time',
    description:
      'Exact local time and UTC offset in a timezone, to coordinate cross-border conversations (e.g. Asia/Shanghai, America/New_York).',
    parameters: {
      type: 'object',
      properties: { time_zone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } },
      required: ['time_zone'],
      additionalProperties: false,
    },
  },
}

const QR_TOOL = {
  type: 'function',
  function: {
    name: 'generate_qr_code',
    description: 'Render a scannable QR code image (Markdown) for a URL, WhatsApp link, email or contact text.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text or URL to encode' },
        label: { type: 'string', description: 'Alt text' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
}

const WIDGET_TOOLS = [LEAD_TOOL, READ_PAGE_TOOL, CURRENCY_TOOL, WORLD_TIME_TOOL, QR_TOOL]

function latinWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length > 1)
}

/** CJK has no spaces, so a bigram is the smallest unit that still carries meaning in a lookup. */
function cjkBigrams(text: string): string[] {
  const out: string[] = []
  for (const chunk of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < chunk.length - 1; i++) {
      out.push(chunk.slice(i, i + 2))
    }
  }
  return out
}

function scoreEntry(row: KnowledgeRow, words: string[]): number {
  const haystack = `${row.question} ${row.answer} ${row.keywords}`.toLowerCase()
  let score = 0
  for (const w of words) {
    if (haystack.includes(w)) {
      score += row.keywords.toLowerCase().split(',').some((k) => k.trim() && w.includes(k.trim())) ? 3 : 1
    }
  }
  return score
}

export function retrieveKnowledge(rows: KnowledgeRow[], message: string): KnowledgeRow[] {
  if (rows.length <= FULL_KB_THRESHOLD) {
    return rows
  }
  const words = [...latinWords(message), ...cjkBigrams(message)]
  const ranked = rows
    .map((row) => ({ row, score: scoreEntry(row, words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_KB_CONTEXT)
    .map((x) => x.row)
  return ranked.length ? ranked : rows.slice(0, MAX_KB_CONTEXT)
}

export function renderKnowledge(rows: KnowledgeRow[]): string {
  if (!rows.length) {
    return '(No knowledge entries yet. Answer only with general, non-committal help and invite the visitor to leave an email or WhatsApp.)'
  }
  return rows
    .map((r) => `### [${r.category}] ${r.question}\n${r.answer}`)
    .join('\n\n')
}

export function buildWidgetSystemPrompt(bot: BotRow, rows: KnowledgeRow[], memories: MemoryRow[] = []): string {
  const soul = bot.soul_prompt.trim()
  const profile = memories.length ? `\n${renderMemoryBlock(memories)}\n` : ''
  return `${soul || `You are the customer service assistant for ${bot.name}, embedded on the company's website.`}

Operating rules (these override the persona above):
- Reply in the visitor's language. Be warm, concise and professional; Markdown is rendered.
- Answer strictly from the [Company Knowledge Base] below. Never invent prices, stock, shipping times, policies or links that are not in it.
- If the visitor asks about a price, discount, MOQ or custom requirement that is not in the knowledge base, say you will let a human follow up and politely ask for their email or WhatsApp.
- The moment the visitor leaves an email / WhatsApp / phone / WeChat, call capture_customer_lead exactly once with the contact and a one-sentence summary of what they want, then confirm briefly that the team will reach out.
- If the visitor sends a product link and asks about specs or a quote, call read_webpage first and answer from what it actually says.
- If the visitor asks for a price in another currency, call get_exchange_rate for a live rate, then combine it with the knowledge base.
- If the visitor asks about your opening hours in their timezone, call get_world_time; if they want a contact QR code, call generate_qr_code.
- You are a public customer-service widget: you have no file, memory, research or MCP tools, and you must not claim to.
${profile}
[Company Knowledge Base]
${renderKnowledge(rows)}`
}

/** Feishu card, Telegram message, or a generic JSON POST — detected from the URL host. */
async function notifyLead(bot: BotRow, lead: { contactInfo: string; inquirySummary: string }): Promise<boolean> {
  const url = bot.webhook_url.trim()
  if (!url) {
    return false
  }
  const text = `🎯 新商机线索 · ${bot.name}\n\n联系方式: ${lead.contactInfo}\n需求摘要: ${lead.inquirySummary}`
  const body = /open\.feishu\.cn|larksuite\.com/.test(url)
    ? {
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: `🎯 新商机线索 · ${bot.name}` }, template: 'green' },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `**联系方式**: ${lead.contactInfo}\n**需求**: ${lead.inquirySummary}` } },
          ],
        },
      }
    : /api\.telegram\.org/.test(url)
      ? { text, parse_mode: 'Markdown' }
      : { event: 'customer_lead', bot: { id: bot.id, name: bot.name }, lead, text }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function runWidgetChat(
  env: Env,
  ctx: ExecutionContext,
  bot: BotRow,
  visitorId: string,
  ip: string | null,
  message: string,
): Promise<string> {
  const db = env.WIDGET_DB
  const memoryOn = bot.memory_enabled === 1
  const [rows, history, memories] = await Promise.all([
    listKnowledge(db, bot.id),
    recentConversations(db, bot.id, visitorId, HISTORY_TURNS),
    memoryOn
      ? listMemories(db, { botId: bot.id, ownerType: 'visitor', ownerId: visitorId }, MEMORY_INJECT_LIMIT)
      : Promise.resolve([] as MemoryRow[]),
  ])

  const messages: ChatMessage[] = [
    { role: 'system', content: buildWidgetSystemPrompt(bot, retrieveKnowledge(rows, message), memories) },
    ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
    { role: 'user', content: message },
  ]

  const route = await resolveLlmRoute(env)
  const client = clientForRoute(env, route)
  const model = route.model ?? env.LLM_MODEL

  let reply = ''
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await chatCompletionWithTools(client, model, messages, WIDGET_TOOLS, {
      maxTokens: 1024,
      timeoutMs: 60_000,
    })
    if (!result.toolCalls.length) {
      reply = result.content
      break
    }
    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      let ack = 'error: unknown tool'
      if (call.function.name === 'read_webpage') {
        try {
          const args = JSON.parse(call.function.arguments || '{}') as { url?: string }
          ack = args.url
            ? await readWebpageMarkdown(args.url, 2500)
            : 'error: url required'
        } catch (err) {
          ack = `error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else if (call.function.name === 'get_exchange_rate') {
        try {
          const args = JSON.parse(call.function.arguments || '{}') as { from?: string; to?: string; amount?: number }
          ack =
            args.from && args.to
              ? await convertCurrency(args.from, args.to, args.amount ?? 1)
              : 'error: from and to are required'
        } catch (err) {
          ack = `error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else if (call.function.name === 'get_world_time') {
        try {
          const args = JSON.parse(call.function.arguments || '{}') as { time_zone?: string }
          ack = args.time_zone ? getWorldTime(args.time_zone) : 'error: time_zone required'
        } catch (err) {
          ack = `error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else if (call.function.name === 'generate_qr_code') {
        try {
          const args = JSON.parse(call.function.arguments || '{}') as { content?: string; label?: string }
          ack = args.content
            ? buildQrCodeMarkdown(args.content, args.label ?? 'QR code')
            : 'error: content required'
        } catch (err) {
          ack = `error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else if (call.function.name === 'capture_customer_lead') {
        try {
          const args = JSON.parse(call.function.arguments || '{}') as {
            contact_info?: string
            inquiry_summary?: string
          }
          const contact = (args.contact_info ?? '').trim()
          const summary = (args.inquiry_summary ?? '').trim() || 'No summary provided'
          if (contact) {
            const leadId = await addLead(db, { botId: bot.id, visitorId, contactInfo: contact, inquirySummary: summary })
            ctx.waitUntil(
              notifyLead(bot, { contactInfo: contact, inquirySummary: summary }).then((ok) =>
                markLeadNotified(db, leadId, ok),
              ),
            )
            ack = 'lead saved'
          } else {
            ack = 'error: contact_info required'
          }
        } catch (err) {
          ack = `error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: ack })
    }
    if (!reply) {
      reply = result.content
    }
  }

  reply = reply.trim() || 'Thanks for reaching out! Please leave your email or WhatsApp and our team will follow up.'

  await addConversation(db, { botId: bot.id, visitorId, ip, role: 'user', content: message })
  await addConversation(db, { botId: bot.id, visitorId, ip, role: 'assistant', content: reply })

  // The reply is already decided; the profile update happens off the response path entirely.
  if (memoryOn) {
    ctx.waitUntil(extractMemories(env, { botId: bot.id, ownerType: 'visitor', ownerId: visitorId }, message, reply))
  }
  return reply
}
