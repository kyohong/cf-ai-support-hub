import { runWidgetChat } from '@/widget/chat'
import { accessIdentity } from '@/widget/memories'
import {
  addKnowledge,
  addMemory,
  clearMemories,
  countMessagesSince,
  countMessagesSinceForBot,
  createBot,
  deleteBot,
  deleteKnowledge,
  deleteMemoryById,
  deleteMemory,
  ensureWidgetSchema,
  getBot,
  listBotMemories,
  listBots,
  listConversations,
  listKnowledge,
  listLeads,
  listMemories,
  statsForBots,  updateBot,
  updateKnowledge,
  updateMemory,
  updateMemoryById,
  type BotInput,
  type BotRow,
  type KnowledgeInput,
  type KnowledgeRow,
  type MemoryScope,
} from '@/widget/db'
import type { ConversationRow, LeadRow } from '@/widget/db'
import type { Env } from '@/types'

const RATE_WINDOW_MS = 60_000
const RATE_MAX_MESSAGES = 6
const ADMIN_LIST_LIMIT = 200
const MAX_MESSAGE_CHARS = 2000

const CORS_HEADERS = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  vary: 'Origin',
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? { ...CORS_HEADERS, 'access-control-allow-origin': origin } : CORS_HEADERS
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) })
}

/** The Origin header is authoritative; a Referer is accepted as the fallback some older embedders
 *  send. Both are compared as *origins* (scheme + host), never as prefixes. */
function originOf(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (origin) {
    return origin.replace(/\/$/, '')
  }
  const referer = request.headers.get('referer')
  if (!referer) {
    return null
  }
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

function isLocal(origin: string | null): boolean {
  return !!origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

export function originAllowed(bot: BotRow, origin: string | null): boolean {
  if (isLocal(origin)) {
    return true
  }
  if (!origin) {
    return false
  }
  return bot.allowed_origins
    .split(',')
    .map((s) => s.trim().replace(/\/$/, '').toLowerCase())
    .filter(Boolean)
    .includes(origin.toLowerCase())
}

function clientIp(request: Request): string | null {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
}

export async function handleWidgetRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = originOf(request)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }
  await ensureWidgetSchema(env.WIDGET_DB)

  if (request.method === 'GET' && url.pathname === '/api/widget/config') {
    const botId = url.searchParams.get('botId') ?? ''
    const bot = botId ? await getBot(env.WIDGET_DB, botId) : null
    if (!bot || bot.enabled !== 1) {
      return json({ error: 'bot unavailable' }, 404, origin)
    }
    if (!originAllowed(bot, origin)) {
      return json({ error: 'origin not allowed' }, 403, origin)
    }
    return json(
      {
        botId: bot.id,
        title: bot.widget_title,
        greeting: bot.widget_greeting,
        color: bot.widget_color,
        memoryEnabled: bot.memory_enabled === 1,
      },
      200,
      origin,
    )
  }

  if (request.method === 'POST' && url.pathname === '/api/widget/chat') {
    let body: { botId?: string; visitorId?: string; message?: string }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return json({ error: 'invalid json' }, 400, origin)
    }
    const botId = (body.botId ?? '').trim()
    const visitorId = (body.visitorId ?? '').trim().slice(0, 64)
    const message = (body.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
    if (!botId || !visitorId || !message) {
      return json({ error: 'botId, visitorId and message are required' }, 400, origin)
    }
    const bot = await getBot(env.WIDGET_DB, botId)
    if (!bot || bot.enabled !== 1) {
      return json({ error: 'bot unavailable', reply: 'This assistant is currently unavailable.' }, 404, origin)
    }
    if (!originAllowed(bot, origin)) {
      return json({ error: 'origin not allowed' }, 403, origin)
    }

    const ip = clientIp(request)
    if (ip) {
      const recent = await countMessagesSince(env.WIDGET_DB, bot.id, ip, new Date(Date.now() - RATE_WINDOW_MS).toISOString())
      if (recent >= RATE_MAX_MESSAGES) {
        return json(
          {
            error: 'rate limited',
            reply: 'You are sending messages very quickly. Please wait a minute and try again. / 发送太频繁，请稍等一分钟再试。',
          },
          429,
          origin,
        )
      }
    }
    const today = await countMessagesSinceForBot(env.WIDGET_DB, bot.id, utcDayStart())
    if (today >= bot.daily_msg_limit) {
      return json(
        {
          error: 'daily limit reached',
          reply:
            'This assistant has reached its daily limit. Please leave your email and our team will get back to you tomorrow. / 今日接待量已达上限，请留下邮箱，我们明天联系您。',
        },
        429,
        origin,
      )
    }

    try {
      const reply = await runWidgetChat(env, ctx, bot, visitorId, ip, message)
      return json({ reply }, 200, origin)
    } catch (err) {
      console.log(JSON.stringify({ at: 'widget', stage: 'chat-failed', bot: bot.id, error: String(err) }))
      return json({ error: 'chat failed', reply: 'Sorry, something went wrong. Please try again in a moment.' }, 500, origin)
    }
  }

  // ——— The visitor's own saved profile, managed from the widget's memory drawer ———
  // Same gate as chat (bot enabled + allowed origin) plus the bot's memory_enabled flag; the
  // visitorId always comes from the caller, exactly as it does for chat.
  if (url.pathname.startsWith('/api/widget/memories')) {
    const botId = url.searchParams.get('botId') ?? ''
    const visitorId = (url.searchParams.get('visitorId') ?? '').trim().slice(0, 64)
    if (!botId || !visitorId) {
      return json({ error: 'botId and visitorId are required' }, 400, origin)
    }
    const bot = await getBot(env.WIDGET_DB, botId)
    if (!bot || bot.enabled !== 1) {
      return json({ error: 'bot unavailable' }, 404, origin)
    }
    if (!originAllowed(bot, origin)) {
      return json({ error: 'origin not allowed' }, 403, origin)
    }
    if (bot.memory_enabled !== 1) {
      return json({ error: 'memory is disabled for this bot' }, 403, origin)
    }
    const scope: MemoryScope = { botId: bot.id, ownerType: 'visitor', ownerId: visitorId }
    const rest = url.pathname.slice('/api/widget/memories'.length).replace(/^\//, '')

    if (request.method === 'GET' && !rest) {
      return json({ items: await listMemories(env.WIDGET_DB, scope) }, 200, origin)
    }

    if (request.method === 'POST' && !rest) {
      const body = (await request.json().catch(() => null)) as { content?: unknown; category?: unknown } | null
      const content = typeof body?.content === 'string' ? body.content.trim().slice(0, 500) : ''
      if (!content) {
        return json({ error: 'content is required' }, 400, origin)
      }
      const category =
        typeof body?.category === 'string' && body.category.trim() ? body.category.trim().slice(0, 40) : 'context'
      return json({ memory: await addMemory(env.WIDGET_DB, scope, { category, content, sourceSessionId: null }) }, 201, origin)
    }

    if (request.method === 'DELETE' && rest === 'clear') {
      return json({ deleted: await clearMemories(env.WIDGET_DB, scope) }, 200, origin)
    }

    if ((request.method === 'PATCH' || request.method === 'DELETE') && rest) {
      if (request.method === 'PATCH') {
        const body = (await request.json().catch(() => null)) as { content?: unknown; category?: unknown } | null
        const content = typeof body?.content === 'string' ? body.content.trim().slice(0, 500) : undefined
        const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 40) : undefined
        if (content === undefined && category === undefined) {
          return json({ error: 'content or category is required' }, 400, origin)
        }
        const memory = await updateMemory(env.WIDGET_DB, scope, rest, { content, category })
        if (!memory) {
          return json({ error: 'memory not found' }, 404, origin)
        }
        return json({ memory }, 200, origin)
      }
      if (!(await deleteMemory(env.WIDGET_DB, scope, rest))) {
        return json({ error: 'memory not found' }, 404, origin)
      }
      return json({ ok: true }, 200, origin)
    }

    return json({ error: 'not found' }, 404, origin)
  }

  return json({ error: 'not found' }, 404, origin)
}

function isBotInput(body: unknown): body is BotInput {
  return !!body && typeof body === 'object' && typeof (body as BotInput).name === 'string'
}

function isKnowledgeInput(body: unknown): body is KnowledgeInput {
  const b = body as KnowledgeInput | null
  return !!b && typeof b === 'object' && typeof b.question === 'string' && typeof b.answer === 'string'
}

/** `Q: ...\nA: ...` blocks separated by a blank line or a `---` line. The first line is the
 *  question, everything after it is the answer, so a long policy paragraph needs no escaping. */
export function parseFaqBatch(text: string): KnowledgeInput[] {
  return text
    .split(/\n\s*(?:---+|===+)?\s*\n\s*\n|\n\s*---+\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const first = lines[0].replace(/^\s*(?:Q(?:uestion)?\s*[:：])\s*/i, '').trim()
      const rest = lines
        .slice(1)
        .join('\n')
        .replace(/^\s*(?:A(?:nswer)?\s*[:：])\s*/i, '')
        .trim()
      return rest ? { question: first, answer: rest } : null
    })
    .filter((x): x is KnowledgeInput => x !== null)
}

async function botPayload(env: Env, bot: BotRow, todayCounts: Record<string, number>): Promise<Record<string, unknown>> {
  const kb = await listKnowledge(env.WIDGET_DB, bot.id)
  return {
    ...bot,
    enabled: bot.enabled === 1,
    memory_enabled: bot.memory_enabled === 1,
    todayMessages: todayCounts[bot.id] ?? 0,
    knowledgeCount: kb.length,
  }
}

export async function handleAdminBotsApi(request: Request, url: URL, env: Env): Promise<Response> {
  await ensureWidgetSchema(env.WIDGET_DB)
  const db = env.WIDGET_DB
  const rest = url.pathname.slice('/api/admin/bots'.length).replace(/^\//, '')
  const parts = rest ? rest.split('/').map(decodeURIComponent) : []
  const [botId, section, itemId] = parts

  if (request.method === 'GET' && !rest) {
    const counts = await statsForBots(db, utcDayStart())
    const bots = await Promise.all((await listBots(db)).map((b) => botPayload(env, b, counts)))
    return Response.json({ bots })
  }

  if (request.method === 'POST' && !rest) {
    const body = (await request.json().catch(() => null)) as unknown
    if (!isBotInput(body)) {
      return Response.json({ error: 'name is required' }, { status: 400 })
    }
    const created = await createBot(db, body)
    return Response.json({ bot: await botPayload(env, created, {}) }, { status: 201 })
  }

  if (!botId) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  const bot = await getBot(db, botId)
  if (!bot) {
    return Response.json({ error: 'bot not found' }, { status: 404 })
  }

  if (!section) {
    if (request.method === 'PUT') {
      const body = (await request.json().catch(() => null)) as Partial<BotInput> | null
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 })
      }
      const updated = await updateBot(db, botId, body)
      return Response.json({ bot: updated ? await botPayload(env, updated, {}) : null })
    }
    if (request.method === 'DELETE') {
      await deleteBot(db, botId)
      return Response.json({ ok: true })
    }
    if (request.method === 'GET') {
      return Response.json({ bot: await botPayload(env, bot, {}) })
    }
  }

  if (section === 'knowledge') {
    if (request.method === 'GET') {
      const items: KnowledgeRow[] = await listKnowledge(db, botId)
      return Response.json({ items })
    }
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as unknown
      const batch = (body as { batch?: unknown } | null)?.batch
      if (typeof batch === 'string' && batch.trim()) {
        const parsed = parseFaqBatch(batch)
        if (!parsed.length) {
          return Response.json({ error: 'nothing parsed — separate entries with a blank line' }, { status: 400 })
        }
        for (const entry of parsed) {
          await addKnowledge(db, botId, entry)
        }
        return Response.json({ imported: parsed.length }, { status: 201 })
      }
      if (Array.isArray((body as { items?: unknown } | null)?.items)) {
        const items = (body as { items: unknown[] }).items
        let imported = 0
        for (const item of items) {
          if (isKnowledgeInput(item)) {
            await addKnowledge(db, botId, item)
            imported++
          }
        }
        return Response.json({ imported }, { status: 201 })
      }
      if (!isKnowledgeInput(body)) {
        return Response.json({ error: 'question and answer are required' }, { status: 400 })
      }
      await addKnowledge(db, botId, body)
      return Response.json({ ok: true }, { status: 201 })
    }
    if (itemId) {
      const id = Number(itemId)
      if (request.method === 'PUT') {
        const body = (await request.json().catch(() => null)) as unknown
        if (!isKnowledgeInput(body)) {
          return Response.json({ error: 'question and answer are required' }, { status: 400 })
        }
        const ok = await updateKnowledge(db, botId, id, body)
        return Response.json({ ok }, { status: ok ? 200 : 404 })
      }
      if (request.method === 'DELETE') {
        const ok = await deleteKnowledge(db, botId, id)
        return Response.json({ ok }, { status: ok ? 200 : 404 })
      }
    }
  }

  if (section === 'conversations' && request.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, ADMIN_LIST_LIMIT)
    const rows: ConversationRow[] = await listConversations(db, botId, limit)
    const group = url.searchParams.get('group') === '1'
    if (!group) {
      return Response.json({ items: rows })
    }
    const byVisitor = new Map<string, ConversationRow[]>()
    for (const row of rows) {
      const list = byVisitor.get(row.visitor_id) ?? []
      list.push(row)
      byVisitor.set(row.visitor_id, list)
    }
    return Response.json({
      threads: [...byVisitor.entries()].map(([visitorId, items]) => ({ visitorId, items })),
    })
  }

  if (section === 'leads' && request.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, ADMIN_LIST_LIMIT)
    const items: LeadRow[] = await listLeads(db, botId, limit)
    return Response.json({ items })
  }

  // ——— Dashboard memory manager: the operator inspects and edits any owner's profile ———
  if (section === 'memories') {
    if (request.method === 'GET' && !itemId) {
      return Response.json({ items: await listBotMemories(db, botId) })
    }
    if (request.method === 'POST' && !itemId) {
      const body = (await request.json().catch(() => null)) as {
        owner_type?: unknown
        owner_id?: unknown
        category?: unknown
        content?: unknown
      } | null
      const content = typeof body?.content === 'string' ? body.content.trim().slice(0, 500) : ''
      if (!content) {
        return Response.json({ error: 'content is required' }, { status: 400 })
      }
      const ownerType = body?.owner_type === 'visitor' ? 'visitor' : 'user'
      const ownerId =
        ownerType === 'visitor'
          ? typeof body?.owner_id === 'string'
            ? body.owner_id.trim().slice(0, 64)
            : ''
          : accessIdentity(request)
      if (!ownerId) {
        return Response.json({ error: 'owner_id is required for visitor memories' }, { status: 400 })
      }
      const category =
        typeof body?.category === 'string' && body.category.trim() ? body.category.trim().slice(0, 40) : 'context'
      const scope: MemoryScope = { botId, ownerType, ownerId }
      const memory = await addMemory(db, scope, { category, content, sourceSessionId: null })
      return Response.json({ memory }, { status: 201 })
    }
    if (request.method === 'DELETE' && itemId === 'clear') {
      const ownerType = url.searchParams.get('ownerType') === 'visitor' ? 'visitor' : 'user'
      const ownerId =
        ownerType === 'visitor' ? (url.searchParams.get('ownerId') ?? '').trim().slice(0, 64) : accessIdentity(request)
      if (!ownerId) {
        return Response.json({ error: 'ownerId is required for visitor memories' }, { status: 400 })
      }
      const scope: MemoryScope = { botId, ownerType, ownerId }
      return Response.json({ deleted: await clearMemories(db, scope) })
    }
    if (itemId && itemId !== 'clear') {
      if (request.method === 'PATCH') {
        const body = (await request.json().catch(() => null)) as { content?: unknown; category?: unknown } | null
        const content = typeof body?.content === 'string' ? body.content.trim().slice(0, 500) : undefined
        const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 40) : undefined
        if (content === undefined && category === undefined) {
          return Response.json({ error: 'content or category is required' }, { status: 400 })
        }
        const memory = await updateMemoryById(db, botId, itemId, { content, category })
        if (!memory) {
          return Response.json({ error: 'memory not found' }, { status: 404 })
        }
        return Response.json({ memory })
      }
      if (request.method === 'DELETE') {
        const ok = await deleteMemoryById(db, botId, itemId)
        return Response.json({ ok }, { status: ok ? 200 : 404 })
      }
    }
  }

  return Response.json({ error: 'not found' }, { status: 404 })
}
