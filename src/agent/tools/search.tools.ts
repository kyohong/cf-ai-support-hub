import { z } from 'zod'
import type { Env } from '@/types'
import { ORPHAN_LOG } from '@/agent/log'
import { defineTool, pageKey, type ToolDef } from '@/agent/tools/registry'
import { rethrowIfExhausted } from '@/agent/subrequest-budget'
import { readAdvancedSettings } from '@/agent/advanced-config'
import { smartWebSearch, type WebHit } from '@/tools/builtin-free-tools'

const SEARCH_RESULTS = 10
const MAX_SEARCH_CHARS = 10_000

/** 分层检索：高级设置里的 Tavily/Brave Key 优先，其次环境变量，最后免 Key 多级容灾。
 *  smartWebSearch 自身不抛异常，这里只负责把命中格式化并喂给 read_page 的缓存。 */
export const searchTools: ToolDef[] = [
  defineTool({
    name: 'web_search',
    description:
      'Search the web for current information. Returns top results with titles, URLs and snippets. Works without any API key.',
    params: z.object({
      query: z.string().describe('The search query'),
      time_range: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe('Only results published within this period. Omit unless the question is about recent events.'),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe('Hostnames to drop from the results, e.g. ["reddit.com"]. No protocol, no path.'),
    }),
    maxResultChars: MAX_SEARCH_CHARS,
    handler: async ({ query, time_range, exclude_domains }, ctx) => {
      const asked = [
        time_range ? `published within the last ${time_range}` : '',
        exclude_domains?.length ? `excluding ${exclude_domains.join(', ')}` : '',
      ].filter(Boolean)

      let outcome
      try {
        const advanced = await readAdvancedSettings(ctx.env)
        outcome = await smartWebSearch(
          query,
          {
            tavilyApiKey: advanced.tavilyApiKey || ctx.env.TAVILY_API_KEY,
            braveApiKey: advanced.braveApiKey,
          },
          SEARCH_RESULTS,
          ctx.budget?.fetch,
        )
      } catch (err) {
        rethrowIfExhausted(err)
        ;(ctx.log ?? ORPHAN_LOG).error({ at: 'web_search', stage: 'unavailable', failures: [String(err)] })
        return 'error: search is unavailable right now. This is a tool failure and says nothing about whether sources exist.'
      }

      if (!outcome.hits.length && !outcome.responded) {
        ;(ctx.log ?? ORPHAN_LOG).error({ at: 'web_search', stage: 'unavailable', failures: outcome.errors })
        return 'error: every search provider refused this request (rate limit or outage). This is a tool failure and says nothing about whether sources exist.'
      }

      let hits: WebHit[] = outcome.hits
      if (exclude_domains?.length) {
        const excluded = new Set(exclude_domains.map((d) => d.toLowerCase().replace(/^www\./, '')))
        hits = hits.filter((r) => {
          try {
            return !excluded.has(new URL(r.url).hostname.replace(/^www\./, '').toLowerCase())
          } catch {
            return false
          }
        })
      }

      ctx.onSearchResults?.(
        hits.map((r) => r.url),
        query,
      )
      let cached = 0
      for (const r of hits) {
        if (r.raw && ctx.pageCache) {
          ctx.pageCache.set(pageKey(r.url), r.raw)
          cached++
        }
      }
      const note = asked.length ? `(${asked.join(', ')})\n\n` : ''
      if (hits.length === 0) {
        return `${note}(no results)`
      }
      const footer = cached ? `\n\n(read_page returns ${cached} of these whole without a fetch)` : ''
      const body = hits.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`).join('\n\n')
      return note + body + footer
    },
  }),
]

/** 供其他模块复用：环境变量 + 高级设置合并后的搜索 Key。 */
export async function searchKeys(env: Env): Promise<{ tavilyApiKey?: string; braveApiKey?: string }> {
  const advanced = await readAdvancedSettings(env)
  return {
    tavilyApiKey: advanced.tavilyApiKey || env.TAVILY_API_KEY,
    braveApiKey: advanced.braveApiKey,
  }
}
