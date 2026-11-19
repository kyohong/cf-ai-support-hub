import type { NotifySettings } from '@/agent/memory/memory-store'
import { createMemoryStore } from '@/agent/memory/vault-store'
import type { Env } from '@/types'

export type { NotifySettings }

/** Env secrets win: they are the supported production channel and cannot be read back from the
 *  browser; vault settings are what the Settings panel writes. A secret set to empty still beats
 *  the vault value, so a channel is disabled only by clearing both places. */
export async function readNotifySettings(env: Env): Promise<NotifySettings> {
  const fromVault = await createMemoryStore(env).getNotifySettings()
  return {
    feishu: env.FEISHU_WEBHOOK_URL || fromVault.feishu,
    telegramToken: env.TELEGRAM_BOT_TOKEN || fromVault.telegramToken,
    telegramChat: env.TELEGRAM_CHAT_ID || fromVault.telegramChat,
  }
}

/** Masked display for the Settings panel: enough to recognise, not enough to reuse. */
export function mask(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  if (value.length <= 8) {
    return '••••••••'
  }
  return `${value.slice(0, 6)}••••${value.slice(-4)}`
}

async function postJson(url: string, body: unknown): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok ? 'ok' : `HTTP ${res.status}`
}

async function sendFeishu(url: string, title: string, body: string): Promise<string> {
  return postJson(url, {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: body.slice(0, 3800) } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '来自 Workers Personal Agent · Cloudflare Free Tier' }] },
      ],
    },
  })
}

async function sendTelegram(token: string, chat: string, title: string, body: string): Promise<string> {
  return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text: `*${title}*\n\n${body.slice(0, 3800)}`,
    parse_mode: 'Markdown',
  })
}

/** Push one message down every configured channel. Per-channel results come back so the caller can
 *  log them — one channel failing must not lose what the other delivered. */
export async function pushAll(env: Env, title: string, body: string): Promise<string[]> {
  const s = await readNotifySettings(env)
  const results: string[] = []
  if (s.feishu) {
    try {
      results.push(`飞书: ${await sendFeishu(s.feishu, title, body)}`)
    } catch (err) {
      results.push(`飞书: 失败 ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (s.telegramToken && s.telegramChat) {
    try {
      results.push(`Telegram: ${await sendTelegram(s.telegramToken, s.telegramChat, title, body)}`)
    } catch (err) {
      results.push(`Telegram: 失败 ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return results
}
