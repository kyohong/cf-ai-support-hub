import { createMemoryStore } from '@/agent/memory/vault-store'
import { pushAll } from '@/agent/notify'
import type { Env } from '@/types'

export const BRIEFING_DEFAULT_KEYWORDS = 'AI、大模型、开发者生态'

/** The digest rides the existing tool loop — search and page tools are already mounted, so the
 *  prompt only has to aim them at the keywords and fix the output shape. */
export function briefingPrompt(keywords: string): string {
  const k = keywords.trim() || BRIEFING_DEFAULT_KEYWORDS
  return (
    `现在生成今日科技早报。请立即使用可用的搜索和网页工具，调研过去 24 小时内关于「${k}」的最重要动态（5-10 条）。` +
    '输出要求（全程中文，精炼，不要寒暄）：\n' +
    '1. 开头一段「核心摘要」：2-3 句话概括今天最重要的趋势。\n' +
    '2. 逐条列出动态：每条含 ① 一句话摘要 ② 一句洞察点评 ③ 来源链接（Markdown 链接）。\n' +
    '3. 结尾一段「今日洞察」：给出一个判断或值得持续关注的方向。'
  )
}

/** Archive the digest into the vault research shelf (it shows up on the memory wall) and push it
 *  down every configured channel. Channel results are returned for the caller to log. */
export async function publishBriefing(env: Env, title: string, body: string): Promise<string[]> {
  try {
    await createMemoryStore(env).saveResearch(title, body)
  } catch (err) {
    console.log(JSON.stringify({ at: 'briefing', stage: 'archive-failed', error: String(err) }))
  }
  return pushAll(env, title, body)
}
