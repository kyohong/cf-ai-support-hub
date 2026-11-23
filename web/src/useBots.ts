import { ref } from 'vue'

export interface Bot {
  id: string
  name: string
  enabled: boolean
  soul_prompt: string
  allowed_origins: string
  daily_msg_limit: number
  webhook_url: string
  widget_title: string
  widget_greeting: string
  widget_color: string
  memory_enabled: boolean
  created_at: string
  todayMessages?: number
  knowledgeCount?: number
}

export interface KnowledgeItem {
  id: number
  bot_id: string
  category: string
  question: string
  answer: string
  keywords: string
  updated_at: string
}

export interface ConversationItem {
  id: number
  visitor_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface LeadItem {
  id: number
  visitor_id: string
  contact_info: string
  inquiry_summary: string
  notified: number
  created_at: string
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function useBots() {
  const bots = ref<Bot[]>([])
  const loading = ref(false)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      bots.value = (await api<{ bots: Bot[] }>('/api/admin/bots')).bots
    } finally {
      loading.value = false
    }
  }

  async function create(name: string): Promise<Bot> {
    const res = await api<{ bot: Bot }>('/api/admin/bots', jsonInit('POST', { name }))
    await refresh()
    return res.bot
  }

  async function update(id: string, patch: Partial<Bot>): Promise<Bot> {
    const res = await api<{ bot: Bot }>(`/api/admin/bots/${encodeURIComponent(id)}`, jsonInit('PUT', patch))
    return res.bot
  }

  async function remove(id: string): Promise<void> {
    await api(`/api/admin/bots/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await refresh()
  }

  return { bots, loading, refresh, create, update, remove }
}

export const knowledgeApi = {
  list: (botId: string) =>
    api<{ items: KnowledgeItem[] }>(`/api/admin/bots/${encodeURIComponent(botId)}/knowledge`).then((r) => r.items),
  add: (botId: string, item: Omit<KnowledgeItem, 'id' | 'bot_id' | 'updated_at'>) =>
    api(`/api/admin/bots/${encodeURIComponent(botId)}/knowledge`, jsonInit('POST', item)),
  update: (botId: string, id: number, item: Omit<KnowledgeItem, 'id' | 'bot_id' | 'updated_at'>) =>
    api(`/api/admin/bots/${encodeURIComponent(botId)}/knowledge/${id}`, jsonInit('PUT', item)),
  remove: (botId: string, id: number) =>
    api(`/api/admin/bots/${encodeURIComponent(botId)}/knowledge/${id}`, { method: 'DELETE' }),
  importBatch: (botId: string, batch: string) =>
    api<{ imported: number }>(`/api/admin/bots/${encodeURIComponent(botId)}/knowledge`, jsonInit('POST', { batch })),
}

export const conversationsApi = {
  list: (botId: string, group = false) =>
    api<{ items?: ConversationItem[]; threads?: { visitorId: string; items: ConversationItem[] }[] }>(
      `/api/admin/bots/${encodeURIComponent(botId)}/conversations?limit=200${group ? '&group=1' : ''}`,
    ),
}

export const leadsApi = {
  list: (botId: string) =>
    api<{ items: LeadItem[] }>(`/api/admin/bots/${encodeURIComponent(botId)}/leads?limit=200`).then((r) => r.items),
}

export interface MemoryItem {
  id: string
  bot_id: string
  owner_type: 'user' | 'visitor'
  owner_id: string
  category: string
  content: string
  updated_at: string
}

export const memoriesApi = {
  /** Every active memory on the bot, all owners (owner_type/owner_id on each item). */
  listAll: (botId: string) =>
    api<{ items: MemoryItem[] }>(`/api/admin/bots/${encodeURIComponent(botId)}/memories`).then((r) => r.items),
  add: (botId: string, item: { owner_type: 'user' | 'visitor'; owner_id?: string; category: string; content: string }) =>
    api<{ memory: MemoryItem }>(`/api/admin/bots/${encodeURIComponent(botId)}/memories`, jsonInit('POST', item)),
  update: (botId: string, id: string, item: { content?: string; category?: string }) =>
    api<{ memory: MemoryItem }>(
      `/api/admin/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(id)}`,
      jsonInit('PATCH', item),
    ),
  remove: (botId: string, id: string) =>
    api(`/api/admin/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clear: (botId: string, ownerType: 'user' | 'visitor', ownerId?: string) =>
    api<{ deleted: number }>(
      `/api/admin/bots/${encodeURIComponent(botId)}/memories/clear?ownerType=${ownerType}${
        ownerId ? `&ownerId=${encodeURIComponent(ownerId)}` : ''
      }`,
      { method: 'DELETE' },
    ),
}
