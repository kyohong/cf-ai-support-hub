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
  return createBot(db, { id, name: `bot ${id}`, memory_enabled: memoryEnabled })
}

async function call(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`http://agent${path}`, {
      method: init?.method,
      headers: { 'content-type': 'application/json', ...init?.headers },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env as Env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** A minimal unsigned Access JWT shape: only the payload is read, and the gate has already
 *  verified the real token by the time the Worker sees the header. */
function accessJwt(email: string): string {
  const b64 = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'RS256' })}.${b64({ email })}.sig`
}

describe('the memory API', () => {
  it('defaults a new bot to memory_enabled and stores a user memory under the web identity', async () => {
    const bot = await seedBot('mem-bot-a')
    expect(bot.memory_enabled).toBe(1)

    const created = await call('/api/memories?botId=mem-bot-a', {
      method: 'POST',
      body: { content: 'Prefers concise answers.', category: 'preference' },
    })
    expect(created.status).toBe(201)
    expect(created.json.memory).toMatchObject({
      owner_type: 'user',
      owner_id: 'dev-user',
      category: 'preference',
      content: 'Prefers concise answers.',
      is_active: 1,
    })

    const list = await call('/api/memories?botId=mem-bot-a')
    expect(list.status).toBe(200)
    expect(list.json.items).toHaveLength(1)
  })

  it('pins user mode to the Access identity and refuses a claimed other owner', async () => {
    await seedBot('mem-bot-b')
    const claimed = await call('/api/memories?botId=mem-bot-b&ownerId=other@example.com', { method: 'GET' })
    expect(claimed.status).toBe(403)
    expect(claimed.json.error).toMatch(/your own/)

    // The email in the (gate-verified) Access JWT is the owner identity.
    const headers = { 'cf-access-jwt-assertion': accessJwt('me@example.com') }
    const created = await call('/api/memories?botId=mem-bot-b', {
      method: 'POST',
      body: { content: 'Ships on Fridays.' },
      headers,
    })
    expect(created.status).toBe(201)
    expect(created.json.memory).toMatchObject({ owner_id: 'me@example.com', category: 'context' })
  })

  it('gates visitor mode on the bot memory_enabled flag and scopes rows to the visitor', async () => {
    await seedBot('mem-bot-on', true)
    await seedBot('mem-bot-off', false)

    const off = await call('/api/memories?botId=mem-bot-off&ownerType=visitor&ownerId=v1', {
      method: 'POST',
      body: { content: 'x' },
    })
    expect(off.status).toBe(403)
    expect(off.json.error).toMatch(/disabled/)

    const visitorMissingId = await call('/api/memories?botId=mem-bot-on&ownerType=visitor', { method: 'GET' })
    expect(visitorMissingId.status).toBe(400)

    const created = await call('/api/memories?botId=mem-bot-on&ownerType=visitor&ownerId=v1', {
      method: 'POST',
      body: { content: 'Visitor speaks English.' },
    })
    expect(created.status).toBe(201)
    expect(created.json.memory).toMatchObject({ owner_type: 'visitor', owner_id: 'v1' })

    // Another visitor sees nothing; the owner id in the query scopes the whole listing.
    const other = await call('/api/memories?botId=mem-bot-on&ownerType=visitor&ownerId=v2')
    expect(other.json.items).toHaveLength(1 - 1)
    const own = await call('/api/memories?botId=mem-bot-on&ownerType=visitor&ownerId=v1')
    expect(own.json.items).toHaveLength(1)
  })

  it('edits content and category through PATCH, scoped to the owner', async () => {
    await seedBot('mem-bot-c')
    const created = await call('/api/memories?botId=mem-bot-c', {
      method: 'POST',
      body: { content: 'Old fact.' },
    })
    const id = (created.json.memory as { id: string }).id

    const missing = await call(`/api/memories/${id}?botId=mem-bot-c`, { method: 'PATCH', body: {} })
    expect(missing.status).toBe(400)

    const patched = await call(`/api/memories/${id}?botId=mem-bot-c`, {
      method: 'PATCH',
      body: { content: 'New fact.', category: 'constraint' },
    })
    expect(patched.status).toBe(200)
    expect(patched.json.memory).toMatchObject({ content: 'New fact.', category: 'constraint' })

    const unknown = await call('/api/memories/no-such-id?botId=mem-bot-c', {
      method: 'PATCH',
      body: { content: 'x' },
    })
    expect(unknown.status).toBe(404)
  })

  it('deletes one item and clears only the requesting owner', async () => {
    await seedBot('mem-bot-d')
    const a = await call('/api/memories?botId=mem-bot-d', { method: 'POST', body: { content: 'A.' } })
    await call('/api/memories?botId=mem-bot-d', { method: 'POST', body: { content: 'B.' } })
    const idA = (a.json.memory as { id: string }).id

    const removed = await call(`/api/memories/${idA}?botId=mem-bot-d`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    const gone = await call(`/api/memories/${idA}?botId=mem-bot-d`, { method: 'DELETE' })
    expect(gone.status).toBe(404)

    // A second owner's rows survive the first owner's clear.
    await call('/api/memories?botId=mem-bot-d&ownerType=visitor&ownerId=v9', {
      method: 'POST',
      body: { content: 'Visitor fact.' },
    })
    const cleared = await call('/api/memories/clear?botId=mem-bot-d', { method: 'DELETE' })
    expect(cleared.json.deleted).toBe(1)
    const visitor = await call('/api/memories?botId=mem-bot-d&ownerType=visitor&ownerId=v9')
    expect(visitor.json.items).toHaveLength(1)
  })

  it('requires an existing bot for every operation', async () => {
    // No bot is seeded, but the fresh D1 still needs the (empty) tables or getBot would throw
    // instead of answering null → 404.
    await (env as Env).WIDGET_DB.batch(widgetSchemaStatements((env as Env).WIDGET_DB))
    expect((await call('/api/memories', { method: 'GET' })).status).toBe(400)
    expect((await call('/api/memories?botId=nope', { method: 'GET' })).status).toBe(404)
    expect((await call('/api/memories?botId=nope', { method: 'POST', body: { content: 'x' } })).status).toBe(404)
  })
})
