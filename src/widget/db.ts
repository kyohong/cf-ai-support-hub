export interface BotRow {
  id: string
  name: string
  enabled: number
  soul_prompt: string
  allowed_origins: string
  daily_msg_limit: number
  webhook_url: string
  widget_title: string
  widget_greeting: string
  widget_color: string
  memory_enabled: number
  created_at: string
  updated_at: string
}

export interface KnowledgeRow {
  id: number
  bot_id: string
  category: string
  question: string
  answer: string
  keywords: string
  updated_at: string
}

export interface ConversationRow {
  id: number
  bot_id: string
  visitor_id: string
  visitor_ip: string | null
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface LeadRow {
  id: number
  bot_id: string
  visitor_id: string
  contact_info: string
  inquiry_summary: string
  notified: number
  created_at: string
}

export interface MemoryRow {
  id: string
  bot_id: string
  owner_type: 'user' | 'visitor'
  owner_id: string
  category: string
  content: string
  source_session_id: string | null
  is_active: number
  created_at: string
  updated_at: string
}

export const BOT_DEFAULTS = {
  widgetTitle: 'AI Support',
  widgetGreeting: 'Hi! How can I help you today?',
  widgetColor: '#2563EB',
  dailyMsgLimit: 100,
}

// Isolate-level memo: the schema statements run once per Worker isolate, not per request. A failed
// batch clears it so the next request retries instead of failing forever. (Tests get fresh D1
// storage per test while the memo survives, so they call widgetSchemaStatements directly.)
let schemaReady: Promise<void> | null = null

export function widgetSchemaStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        soul_prompt TEXT DEFAULT '',
        allowed_origins TEXT DEFAULT '',
        daily_msg_limit INTEGER DEFAULT 100,
        webhook_url TEXT DEFAULT '',
        widget_title TEXT DEFAULT 'AI Support',
        widget_greeting TEXT DEFAULT 'Hi! How can I help you today?',
        widget_color TEXT DEFAULT '#2563EB',
        memory_enabled INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT
      )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bot_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        category TEXT DEFAULT 'General',
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        keywords TEXT DEFAULT '',
        updated_at TEXT
      )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bot_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        visitor_ip TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT
      )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bot_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        contact_info TEXT NOT NULL,
        inquiry_summary TEXT NOT NULL,
        notified INTEGER DEFAULT 0,
        created_at TEXT
      )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_knowledge_bot ON bot_knowledge (bot_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_bot_time ON bot_conversations (bot_id, created_at)`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON bot_conversations (bot_id, visitor_id, created_at)`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_bot ON bot_leads (bot_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'visitor')),
        owner_id TEXT NOT NULL,
        category TEXT DEFAULT 'context',
        content TEXT NOT NULL,
        source_session_id TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT
      )`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_user_memories_owner
          ON user_memories (bot_id, owner_type, owner_id, is_active)`,
    ),
  ]
}

export function ensureWidgetSchema(db: D1Database): Promise<void> {
  schemaReady ??= db
    .batch(widgetSchemaStatements(db))
    .then(async () => {
      // Existing deployments have a bots table without the column, and CREATE TABLE IF NOT EXISTS
      // will not add it. SQLite has no ADD COLUMN IF NOT EXISTS, so the duplicate-column error on
      // already-migrated tables is the expected no-op and is swallowed.
      await db
        .prepare('ALTER TABLE bots ADD COLUMN memory_enabled INTEGER DEFAULT 1')
        .run()
        .catch(() => undefined)
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      schemaReady = null
      throw err
    })
  return schemaReady
}

const now = () => new Date().toISOString()

export async function getBot(db: D1Database, id: string): Promise<BotRow | null> {
  return db.prepare('SELECT * FROM bots WHERE id = ?').bind(id).first<BotRow>()
}

export async function listBots(db: D1Database): Promise<BotRow[]> {
  const { results } = await db.prepare('SELECT * FROM bots ORDER BY created_at DESC').all<BotRow>()
  return results
}

export interface BotInput {
  id?: string
  name: string
  enabled?: boolean | number
  soul_prompt?: string
  allowed_origins?: string
  daily_msg_limit?: number
  webhook_url?: string
  widget_title?: string
  widget_greeting?: string
  widget_color?: string
  memory_enabled?: boolean | number
}

export function botIdFrom(name: string, given?: string): string {
  const clean = (given ?? '').trim()
  if (clean) {
    return /^[a-z][a-z0-9_-]{1,63}$/.test(clean) ? clean : slug(`bot_${clean}`)
  }
  return slug(`bot_${name}`) || `bot_${crypto.randomUUID().slice(0, 8)}`
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export async function createBot(db: D1Database, input: BotInput): Promise<BotRow> {
  const id = botIdFrom(input.name, input.id)
  const at = now()
  await db
    .prepare(
      `INSERT INTO bots (id, name, enabled, soul_prompt, allowed_origins, daily_msg_limit, webhook_url,
        widget_title, widget_greeting, widget_color, memory_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name.trim(),
      input.enabled === false ? 0 : 1,
      input.soul_prompt ?? '',
      input.allowed_origins ?? '',
      input.daily_msg_limit ?? BOT_DEFAULTS.dailyMsgLimit,
      input.webhook_url ?? '',
      input.widget_title ?? BOT_DEFAULTS.widgetTitle,
      input.widget_greeting ?? BOT_DEFAULTS.widgetGreeting,
      input.widget_color ?? BOT_DEFAULTS.widgetColor,
      input.memory_enabled === false ? 0 : 1,
      at,
      at,
    )
    .run()
  const row = await getBot(db, id)
  if (!row) {
    throw new Error('bot insert failed')
  }
  return row
}

export async function updateBot(db: D1Database, id: string, input: Partial<BotInput>): Promise<BotRow | null> {
  const current = await getBot(db, id)
  if (!current) {
    return null
  }
  await db
    .prepare(
      `UPDATE bots SET name = ?, enabled = ?, soul_prompt = ?, allowed_origins = ?, daily_msg_limit = ?,
        webhook_url = ?, widget_title = ?, widget_greeting = ?, widget_color = ?, memory_enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      input.name?.trim() || current.name,
      input.enabled === undefined ? current.enabled : input.enabled === false || input.enabled === 0 ? 0 : 1,
      input.soul_prompt ?? current.soul_prompt,
      input.allowed_origins ?? current.allowed_origins,
      input.daily_msg_limit ?? current.daily_msg_limit,
      input.webhook_url ?? current.webhook_url,
      input.widget_title ?? current.widget_title,
      input.widget_greeting ?? current.widget_greeting,
      input.widget_color ?? current.widget_color,
      input.memory_enabled === undefined
        ? current.memory_enabled
        : input.memory_enabled === false || input.memory_enabled === 0
          ? 0
          : 1,
      now(),
      id,
    )
    .run()
  return getBot(db, id)
}

export async function deleteBot(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bot_knowledge WHERE bot_id = ?').bind(id),
    db.prepare('DELETE FROM bot_conversations WHERE bot_id = ?').bind(id),
    db.prepare('DELETE FROM bot_leads WHERE bot_id = ?').bind(id),
    db.prepare('DELETE FROM user_memories WHERE bot_id = ?').bind(id),
    db.prepare('DELETE FROM bots WHERE id = ?').bind(id),
  ])
}

export async function listKnowledge(db: D1Database, botId: string): Promise<KnowledgeRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bot_knowledge WHERE bot_id = ? ORDER BY category, id DESC')
    .bind(botId)
    .all<KnowledgeRow>()
  return results
}

export interface KnowledgeInput {
  category?: string
  question: string
  answer: string
  keywords?: string
}

export async function addKnowledge(db: D1Database, botId: string, input: KnowledgeInput): Promise<void> {
  await db
    .prepare(
      'INSERT INTO bot_knowledge (bot_id, category, question, answer, keywords, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      botId,
      input.category?.trim() || 'General',
      input.question.trim(),
      input.answer.trim(),
      input.keywords ?? '',
      now(),
    )
    .run()
}

export async function updateKnowledge(
  db: D1Database,
  botId: string,
  id: number,
  input: KnowledgeInput,
): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE bot_knowledge SET category = ?, question = ?, answer = ?, keywords = ?, updated_at = ? WHERE id = ? AND bot_id = ?',
    )
    .bind(
      input.category?.trim() || 'General',
      input.question.trim(),
      input.answer.trim(),
      input.keywords ?? '',
      now(),
      id,
      botId,
    )
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function deleteKnowledge(db: D1Database, botId: string, id: number): Promise<boolean> {
  const res = await db.prepare('DELETE FROM bot_knowledge WHERE id = ? AND bot_id = ?').bind(id, botId).run()
  return (res.meta.changes ?? 0) > 0
}

export async function addConversation(
  db: D1Database,
  row: { botId: string; visitorId: string; ip: string | null; role: 'user' | 'assistant'; content: string },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO bot_conversations (bot_id, visitor_id, visitor_ip, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(row.botId, row.visitorId, row.ip, row.role, row.content, now())
    .run()
}

export async function recentConversations(
  db: D1Database,
  botId: string,
  visitorId: string,
  limit: number,
): Promise<ConversationRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bot_conversations WHERE bot_id = ? AND visitor_id = ? ORDER BY id DESC LIMIT ?')
    .bind(botId, visitorId, limit)
    .all<ConversationRow>()
  return results.reverse()
}

export async function listConversations(db: D1Database, botId: string, limit: number): Promise<ConversationRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bot_conversations WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
    .bind(botId, limit)
    .all<ConversationRow>()
  return results
}

export async function countMessagesSince(db: D1Database, botId: string, ip: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bot_conversations WHERE bot_id = ? AND visitor_ip = ? AND role = 'user' AND created_at >= ?`,
    )
    .bind(botId, ip, sinceIso)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function countMessagesSinceForBot(db: D1Database, botId: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM bot_conversations WHERE bot_id = ? AND role = 'user' AND created_at >= ?`)
    .bind(botId, sinceIso)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function statsForBots(db: D1Database, dayStartIso: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT bot_id, COUNT(*) AS n FROM bot_conversations WHERE role = 'user' AND created_at >= ? GROUP BY bot_id`,
    )
    .bind(dayStartIso)
    .all<{ bot_id: string; n: number }>()
  return Object.fromEntries(results.map((r) => [r.bot_id, r.n]))
}

export async function addLead(
  db: D1Database,
  row: { botId: string; visitorId: string; contactInfo: string; inquirySummary: string },
): Promise<number> {
  const res = await db
    .prepare(
      'INSERT INTO bot_leads (bot_id, visitor_id, contact_info, inquiry_summary, notified, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    )
    .bind(row.botId, row.visitorId, row.contactInfo, row.inquirySummary, now())
    .run()
  return res.meta.last_row_id ?? 0
}

export async function markLeadNotified(db: D1Database, id: number, ok: boolean): Promise<void> {
  await db
    .prepare('UPDATE bot_leads SET notified = ? WHERE id = ?')
    .bind(ok ? 1 : 0, id)
    .run()
}

export async function listLeads(db: D1Database, botId: string, limit: number): Promise<LeadRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bot_leads WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
    .bind(botId, limit)
    .all<LeadRow>()
  return results
}

/** Whose memories these are: the bot plus the owner the whole query is scoped to. Every memory
 *  query below filters on all three, so a row can never leak across owners. */
export interface MemoryScope {
  botId: string
  ownerType: 'user' | 'visitor'
  ownerId: string
}

export async function listMemories(db: D1Database, scope: MemoryScope, limit?: number): Promise<MemoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM user_memories WHERE bot_id = ? AND owner_type = ? AND owner_id = ? AND is_active = 1
       ORDER BY updated_at DESC${limit ? ' LIMIT ?' : ''}`,
    )
    .bind(...(limit ? [scope.botId, scope.ownerType, scope.ownerId, limit] : [scope.botId, scope.ownerType, scope.ownerId]))
    .all<MemoryRow>()
  return results
}

export async function addMemory(
  db: D1Database,
  scope: MemoryScope,
  input: { category: string; content: string; sourceSessionId: string | null },
): Promise<MemoryRow> {
  const at = now()
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    bot_id: scope.botId,
    owner_type: scope.ownerType,
    owner_id: scope.ownerId,
    category: input.category,
    content: input.content,
    source_session_id: input.sourceSessionId,
    is_active: 1,
    created_at: at,
    updated_at: at,
  }
  await db
    .prepare(
      `INSERT INTO user_memories (id, bot_id, owner_type, owner_id, category, content, source_session_id,
        is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.bot_id,
      row.owner_type,
      row.owner_id,
      row.category,
      row.content,
      row.source_session_id,
      row.is_active,
      row.created_at,
      row.updated_at,
    )
    .run()
  return row
}

export async function updateMemory(
  db: D1Database,
  scope: MemoryScope,
  id: string,
  input: { content?: string; category?: string },
): Promise<MemoryRow | null> {
  const current = await db
    .prepare('SELECT * FROM user_memories WHERE id = ? AND bot_id = ? AND owner_type = ? AND owner_id = ?')
    .bind(id, scope.botId, scope.ownerType, scope.ownerId)
    .first<MemoryRow>()
  if (!current) {
    return null
  }
  const content = input.content ?? current.content
  const category = input.category ?? current.category
  const updated: MemoryRow = { ...current, content, category, updated_at: now() }
  await db
    .prepare('UPDATE user_memories SET content = ?, category = ?, updated_at = ? WHERE id = ?')
    .bind(content, category, updated.updated_at, id)
    .run()
  return updated
}

export async function deleteMemory(db: D1Database, scope: MemoryScope, id: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM user_memories WHERE id = ? AND bot_id = ? AND owner_type = ? AND owner_id = ?')
    .bind(id, scope.botId, scope.ownerType, scope.ownerId)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function clearMemories(db: D1Database, scope: MemoryScope): Promise<number> {
  const res = await db
    .prepare('DELETE FROM user_memories WHERE bot_id = ? AND owner_type = ? AND owner_id = ?')
    .bind(scope.botId, scope.ownerType, scope.ownerId)
    .run()
  return res.meta.changes ?? 0
}

/** Hard cap on active memories per owner: drops the stalest rows (oldest updated_at) beyond `cap`. */
export async function trimMemories(db: D1Database, scope: MemoryScope, cap: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id FROM user_memories WHERE bot_id = ? AND owner_type = ? AND owner_id = ? AND is_active = 1
       ORDER BY updated_at DESC LIMIT -1 OFFSET ?`,
    )
    .bind(scope.botId, scope.ownerType, scope.ownerId, cap)
    .all<{ id: string }>()
  if (!results.length) {
    return 0
  }
  const stale = db.prepare('DELETE FROM user_memories WHERE id = ?')
  await db.batch(results.map((r) => stale.bind(r.id)))
  return results.length
}

// ——— Dashboard (admin) memory management: the operator manages any owner's rows on their bot ———

/** Every active memory on a bot, all owners, grouped by owner then newest first. */
export async function listBotMemories(db: D1Database, botId: string): Promise<MemoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM user_memories WHERE bot_id = ? AND is_active = 1
       ORDER BY owner_type, owner_id, updated_at DESC`,
    )
    .bind(botId)
    .all<MemoryRow>()
  return results
}

export async function updateMemoryById(
  db: D1Database,
  botId: string,
  id: string,
  input: { content?: string; category?: string },
): Promise<MemoryRow | null> {
  const current = await db
    .prepare('SELECT * FROM user_memories WHERE id = ? AND bot_id = ?')
    .bind(id, botId)
    .first<MemoryRow>()
  if (!current) {
    return null
  }
  const content = input.content ?? current.content
  const category = input.category ?? current.category
  const updated: MemoryRow = { ...current, content, category, updated_at: now() }
  await db
    .prepare('UPDATE user_memories SET content = ?, category = ?, updated_at = ? WHERE id = ?')
    .bind(content, category, updated.updated_at, id)
    .run()
  return updated
}

export async function deleteMemoryById(db: D1Database, botId: string, id: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM user_memories WHERE id = ? AND bot_id = ?')
    .bind(id, botId)
    .run()
  return (res.meta.changes ?? 0) > 0
}
