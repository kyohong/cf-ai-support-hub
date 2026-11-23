import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '@/index'
import { createBot, widgetSchemaStatements } from '@/widget/db'
import type { Env } from '@/types'

// D1 storage is isolated per test, but the isolate-level schema memo in db.ts survives that wipe,
// so the tests create the schema directly instead of going through ensureWidgetSchema.
async function seedBot(id: string, memoryEnabled?: boolean) {
  const db = (env as Env).WIDGET_DB
  await db.batch(widgetSchemaStatements(db))
  return createBot(db, { id, name: `bot ${id}`, memory_enabled: memoryEnabled, widget_title: `w-${id}` })
}

async function call(
  path: string,
  init?: { method?: string; body?: unknown; origin?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`http://agent${path}`, {
      method: init?.method,
      headers: { 'content-type': 'application/json', origin: init?.origin ?? 'http://localhost:3000' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env as Env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('the widget visitor memory endpoints', () => {
  it('lets a visitor list, add, edit and delete their own profile', async () => {
    await seedBot('wm-bot', true)

    const created = await call('/api/widget/memories?botId=wm-bot&visitorId=v1', {
      method: 'POST',
      body: { content: 'The visitor prefers English.', category: 'preference' },
    })
    expect(created.status).toBe(201)
    const id = (created.json.memory as { id: string }).id

    const patched = await call(`/api/widget/memories/${id}?botId=wm-bot&visitorId=v1`, {
      method: 'PATCH',
      body: { content: 'The visitor prefers German.' },
    })
    expect(patched.status).toBe(200)
    expect(patched.json.memory).toMatchObject({ content: 'The visitor prefers German.' })

    const list = await call('/api/widget/memories?botId=wm-bot&visitorId=v1')
    expect(list.status).toBe(200)
    expect(list.json.items).toHaveLength(1)

    const removed = await call(`/api/widget/memories/${id}?botId=wm-bot&visitorId=v1`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await call('/api/widget/memories?botId=wm-bot&visitorId=v1')).json.items).toHaveLength(0)
  })

  it('gates every visitor memory call on origin, bot availability and memory_enabled', async () => {
    await seedBot('wm-open', true)
    await seedBot('wm-muted', false)

    // A disallowed origin is refused even though the bot exists and has memory on.
    const badOrigin = await call('/api/widget/memories?botId=wm-open&visitorId=v1', { origin: 'https://evil.example' })
    expect(badOrigin.status).toBe(403)

    // Localhost origins are always allowed.
    expect((await call('/api/widget/memories?botId=wm-open&visitorId=v1')).status).toBe(200)

    const muted = await call('/api/widget/memories?botId=wm-muted&visitorId=v1')
    expect(muted.status).toBe(403)
    expect(muted.json.error).toMatch(/disabled/)

    const missingBot = await call('/api/widget/memories?botId=nope&visitorId=v1')
    expect(missingBot.status).toBe(404)
  })

  it('clears all of one visitor but never another visitor', async () => {
    await seedBot('wm-clear', true)
    await call('/api/widget/memories?botId=wm-clear&visitorId=v1', { method: 'POST', body: { content: 'A.' } })
    await call('/api/widget/memories?botId=wm-clear&visitorId=v2', { method: 'POST', body: { content: 'B.' } })

    const cleared = await call('/api/widget/memories/clear?botId=wm-clear&visitorId=v1', { method: 'DELETE' })
    expect(cleared.json.deleted).toBe(1)
    expect((await call('/api/widget/memories?botId=wm-clear&visitorId=v1')).json.items).toHaveLength(0)
    expect((await call('/api/widget/memories?botId=wm-clear&visitorId=v2')).json.items).toHaveLength(1)
  })

  it('exposes memoryEnabled in the widget config and never in a disabled bot', async () => {
    await seedBot('wm-cfg', true)
    const config = await call('/api/widget/config?botId=wm-cfg')
    expect(config.json.memoryEnabled).toBe(true)
  })
})

describe('the dashboard memory manager API', () => {
  it('lists every owner, adds under the Access identity or an explicit visitor, and edits by id', async () => {
    await seedBot('adm-mem')
    await call('/api/memories?botId=adm-mem&ownerType=visitor&ownerId=v7', {
      method: 'POST',
      body: { content: 'Visitor fact.' },
    })

    const all = await call('/api/admin/bots/adm-mem/memories')
    expect(all.status).toBe(200)
    expect(all.json.items).toHaveLength(1)
    expect((all.json.items as { owner_type: string }[])[0].owner_type).toBe('visitor')

    const personal = await call('/api/admin/bots/adm-mem/memories', {
      method: 'POST',
      body: { content: 'Operator note.', category: 'constraint' },
    })
    expect(personal.status).toBe(201)
    expect(personal.json.memory).toMatchObject({ owner_type: 'user', owner_id: 'dev-user' })

    const visitorAdded = await call('/api/admin/bots/adm-mem/memories', {
      method: 'POST',
      body: { owner_type: 'visitor', owner_id: 'v8', content: 'Added by operator.' },
    })
    expect(visitorAdded.json.memory).toMatchObject({ owner_type: 'visitor', owner_id: 'v8' })

    const id = (visitorAdded.json.memory as { id: string }).id
    const patched = await call(`/api/admin/bots/adm-mem/memories/${id}`, {
      method: 'PATCH',
      body: { content: 'Rewritten by operator.', category: 'profile' },
    })
    expect(patched.json.memory).toMatchObject({ content: 'Rewritten by operator.', category: 'profile' })

    const removed = await call(`/api/admin/bots/adm-mem/memories/${id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await call('/api/admin/bots/adm-mem/memories')).json.items).toHaveLength(2)
  })

  it('clears one visitor profile from the dashboard without touching others', async () => {
    await seedBot('adm-clear')
    await call('/api/memories?botId=adm-clear', { method: 'POST', body: { content: 'Operator fact.' } })
    await call('/api/memories?botId=adm-clear&ownerType=visitor&ownerId=v1', {
      method: 'POST',
      body: { content: 'V1 fact.' },
    })

    const cleared = await call('/api/admin/bots/adm-clear/memories/clear?ownerType=visitor&ownerId=v1', {
      method: 'DELETE',
    })
    expect(cleared.json.deleted).toBe(1)
    const rest = (await call('/api/admin/bots/adm-clear/memories')).json.items as unknown[]
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ owner_type: 'user' })
  })

  it('toggles memory_enabled on the bot record', async () => {
    await seedBot('adm-toggle', true)
    const off = await call('/api/admin/bots/adm-toggle', { method: 'PUT', body: { memory_enabled: false } })
    expect(off.json.bot).toMatchObject({ memory_enabled: false })
    const on = await call('/api/admin/bots/adm-toggle', { method: 'PUT', body: { memory_enabled: true } })
    expect(on.json.bot).toMatchObject({ memory_enabled: true })
  })
})
