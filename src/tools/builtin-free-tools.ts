import { z } from 'zod'
import { defineTool, type ToolDef } from '@/agent/tools/registry'

const FETCH_TIMEOUT_MS = 20_000
const SANDBOX_TIMEOUT_MS = 25_000
const MAX_SANDBOX_CODE = 4000
const MAX_TOOL_CHARS = 6000

/** SSRF 过滤：只放行公网 http(s) URL，内网/本机地址一律拒绝。 */
export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed')
  }
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.startsWith('[') ||
    host === '0.0.0.0'
  ) {
    throw new Error('private or local addresses are not allowed')
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    const isPrivate =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    if (isPrivate) {
      throw new Error('private or local addresses are not allowed')
    }
  }
  return url
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated at ${max} characters)` : text
}

type FetchLike = typeof globalThis.fetch

/** 用 Jina Reader 把任意公开网页转成干净 Markdown 正文（零 API Key）。 */
export async function readWebpageMarkdown(url: string, maxChars = 4500, doFetch?: FetchLike): Promise<string> {
  const target = assertPublicUrl(url)
  const fetchImpl = doFetch ?? globalThis.fetch
  const res = await fetchImpl(`https://r.jina.ai/${target.toString()}`, {
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`reader HTTP ${res.status}`)
  }
  const text = (await res.text()).trim()
  if (!text) {
    throw new Error('reader returned an empty page')
  }
  return clip(text, Math.max(500, Math.min(maxChars, MAX_TOOL_CHARS)))
}

const CURRENCY_RE = /^[A-Z]{3}$/

/** 欧洲央行免费汇率（frankfurter.app），实时换算，零 API Key。 */
export async function convertCurrency(
  from: string,
  to: string,
  amount = 1,
  doFetch?: FetchLike,
): Promise<string> {
  const base = from.trim().toUpperCase()
  const quote = to.trim().toUpperCase()
  if (!CURRENCY_RE.test(base) || !CURRENCY_RE.test(quote)) {
    throw new Error('currency codes must be 3 letters, e.g. USD / CNY / EUR')
  }
  const value = amount
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('amount must be a positive number')
  }
  if (base === quote) {
    return `${value} ${base} = ${value} ${quote}`
  }
  const fetchImpl = doFetch ?? globalThis.fetch
  const res = await fetchImpl(`https://api.frankfurter.app/latest?from=${base}&to=${quote}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`exchange-rate HTTP ${res.status}`)
  }
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> }
  const rate = body.rates?.[quote]
  if (typeof rate !== 'number') {
    throw new Error(`no rate for ${base} -> ${quote}`)
  }
  const converted = (value * rate).toFixed(4).replace(/\.?0+$/, '')
  return `${value} ${base} = ${converted} ${quote} (rate ${rate}, ECB ${body.date ?? 'latest'})`
}

/** Piston 公共沙箱跑 Python 3.10：精确数学、体积重、阶梯折扣、数据分析都靠它。 */
export async function executePythonSandbox(code: string, doFetch?: FetchLike): Promise<string> {
  const source = (code ?? '').trim()
  if (!source) {
    throw new Error('code is required')
  }
  if (source.length > MAX_SANDBOX_CODE) {
    throw new Error(`code too long (${source.length} > ${MAX_SANDBOX_CODE} characters)`)
  }
  const fetchImpl = doFetch ?? globalThis.fetch
  const res = await fetchImpl('https://emkc.org/api/v2/piston/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', version: '3.10.0', files: [{ content: source }] }),
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`sandbox HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    run?: { stdout?: string; stderr?: string; output?: string; code?: number }
    message?: string
  }
  if (body.message) {
    throw new Error(`sandbox: ${body.message}`)
  }
  const out = (body.run?.stdout ?? '').trim()
  const err = (body.run?.stderr ?? '').trim()
  const combined = [out, err && `[stderr]\n${err}`].filter(Boolean).join('\n') || '(no output)'
  return clip(combined, MAX_TOOL_CHARS)
}

/** Chart.js 配置 → QuickChart 图片链接，直接给 Markdown 图表。 */
export function buildChartMarkdown(chartConfigJson: string, title = 'chart'): string {
  const raw = (chartConfigJson ?? '').trim()
  if (!raw) {
    throw new Error('chart config is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('chart config must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('chart config must be a Chart.js config object')
  }
  const encoded = encodeURIComponent(JSON.stringify(parsed))
  const safeTitle = title.replace(/[[\]()]/g, '').slice(0, 80) || 'chart'
  return `![${safeTitle}](https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=white)`
}

// ———————————————————— 搜索：免 Key 多级容灾 ————————————————————

export interface SearchKeys {
  tavilyApiKey?: string
  braveApiKey?: string
}

export interface WebHit {
  title: string
  url: string
  description: string
  /** Tavily 直接带回的正文，供 read_page 的缓存复用。 */
  raw?: string
}

export interface SmartSearchOutcome {
  hits: WebHit[]
  /** 实际尝试过的层级，供日志与"空结果"归因。 */
  attempts: string[]
  errors: string[]
  /** 是否至少有一层正常应答（即使是零结果）——区分"全网为空"与"全部被拒"。 */
  responded: boolean
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim()
}

async function tavilyHits(
  key: string,
  query: string,
  maxResults: number,
  doFetch?: FetchLike,
): Promise<WebHit[]> {
  const res = await (doFetch ?? fetch)('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, include_answer: false }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`tavily HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string }>
  }
  return (body.results ?? [])
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.content ?? '',
      ...(r.raw_content ? { raw: r.raw_content } : {}),
    }))
}

async function braveHits(key: string, query: string, maxResults: number, doFetch?: FetchLike): Promise<WebHit[]> {
  const res = await (doFetch ?? fetch)(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    {
      headers: { accept: 'application/json', 'x-subscription-token': key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  )
  if (!res.ok) {
    throw new Error(`brave HTTP ${res.status}`)
  }
  const body = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
  return (body.web?.results ?? [])
    .filter((r) => r.url && r.title)
    .map((r) => ({ title: decodeEntities(r.title ?? ''), url: r.url ?? '', description: decodeEntities(r.description ?? '') }))
}

async function duckDuckGoHits(query: string, maxResults: number, doFetch?: FetchLike): Promise<WebHit[]> {
  const res = await (doFetch ?? fetch)(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; PersonalAgent/1.0)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`duckduckgo HTTP ${res.status}`)
  }
  const html = await res.text()
  const titles = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => decodeEntities(m[1]))
  const hits: WebHit[] = []
  for (const [i, m] of titles.slice(0, maxResults).entries()) {
    const raw = m[1]
    const uddg = /[?&]uddg=([^&]+)/.exec(raw)
    const url = uddg ? decodeURIComponent(uddg[1]) : raw
    const title = decodeEntities(m[2])
    if (!/^https?:\/\//.test(url) || !title) {
      continue
    }
    hits.push({ title, url, description: snippets[i] ?? '' })
  }
  return hits
}

async function wikipediaHits(query: string, maxResults: number, doFetch?: FetchLike): Promise<WebHit[]> {
  const res = await (doFetch ?? fetch)(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(maxResults, 5)}`,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  )
  if (!res.ok) {
    throw new Error(`wikipedia HTTP ${res.status}`)
  }
  const body = (await res.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } }
  return (body.query?.search ?? [])
    .filter((r) => r.title)
    .map((r) => ({
      title: r.title ?? '',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((r.title ?? '').replaceAll(' ', '_'))}`,
      description: decodeEntities(r.snippet ?? ''),
    }))
}

async function hackerNewsHits(query: string, maxResults: number, doFetch?: FetchLike): Promise<WebHit[]> {
  const res = await (doFetch ?? fetch)(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  )
  if (!res.ok) {
    throw new Error(`hackernews HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    hits?: Array<{ title?: string; url?: string | null; story_text?: string | null; objectID?: string }>
  }
  return (body.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title ?? '',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID ?? ''}`,
      description: decodeEntities((h.story_text ?? '').slice(0, 240)),
    }))
}

/** 免 Key 多级容灾搜索：Tavily Key → Brave Key → DuckDuckGo HTML → Wikipedia + HN。
 *  任何一层失败都只记录不抛出，零 Key 环境下也 100% 返回一个结果对象。 */
export async function smartWebSearch(
  query: string,
  config: SearchKeys = {},
  maxResults = 5,
  doFetch?: FetchLike,
): Promise<SmartSearchOutcome> {
  const q = (query ?? '').trim().slice(0, 400)
  const attempts: string[] = []
  const errors: string[] = []
  if (!q) {
    return { hits: [], attempts, errors: ['empty query'], responded: false }
  }
  const tiers: Array<{ name: string; run: () => Promise<WebHit[]> }> = []
  if (config.tavilyApiKey) {
    tiers.push({ name: 'tavily', run: () => tavilyHits(config.tavilyApiKey!, q, maxResults, doFetch) })
  }
  if (config.braveApiKey) {
    tiers.push({ name: 'brave', run: () => braveHits(config.braveApiKey!, q, maxResults, doFetch) })
  }
  tiers.push({ name: 'duckduckgo', run: () => duckDuckGoHits(q, maxResults, doFetch) })
  tiers.push({ name: 'wikipedia', run: () => wikipediaHits(q, Math.min(maxResults, 5), doFetch) })
  tiers.push({ name: 'hackernews', run: () => hackerNewsHits(q, Math.min(maxResults, 8), doFetch) })

  let responded = false
  for (const tier of tiers) {
    attempts.push(tier.name)
    try {
      const hits = await tier.run()
      responded = true
      if (hits.length > 0) {
        // 不在这里二次截断：供应商已按 maxResults 请求，超量的部分由 loop 按字符预算处理
        // （历史契约：handler 不切结果集，只声明上限）。
        return { hits, attempts, errors, responded }
      }
      errors.push(`${tier.name}: no results`)
    } catch (err) {
      errors.push(`${tier.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { hits: [], attempts, errors, responded }
}

// ———————————————————— 早报 / 天气 / 时区 / 二维码 ————————————————————

export interface TechNewsItem {
  title: string
  url: string
  points?: number
  comments?: number
}

/** HackerNews 官方免费 API：热门 AI/科技头条，供每日早报直接使用。 */
export async function fetchTopTechNews(limit = 8, doFetch?: FetchLike): Promise<TechNewsItem[]> {
  const res = await (doFetch ?? fetch)(
    `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${Math.min(Math.max(limit, 1), 30)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  )
  if (!res.ok) {
    throw new Error(`hackernews HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    hits?: Array<{ title?: string; url?: string | null; points?: number; num_comments?: number; objectID?: string }>
  }
  return (body.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title ?? '',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID ?? ''}`,
      points: h.points,
      comments: h.num_comments,
    }))
}

const WEATHER_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  80: 'rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  95: 'thunderstorm',
}

const describeWeather = (code: number | undefined): string => (code === undefined ? 'unknown' : (WEATHER_CODES[code] ?? `code ${code}`))

/** Open-Meteo 免 Key：地理编码 + 实时天气 + 未来 3 天预报。 */
export async function getCityWeather(city: string, doFetch?: FetchLike): Promise<string> {
  const name = (city ?? '').trim().slice(0, 80)
  if (!name) {
    throw new Error('city is required')
  }
  const fetchImpl = doFetch ?? fetch
  const geoRes = await fetchImpl(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  )
  if (!geoRes.ok) {
    throw new Error(`geocoding HTTP ${geoRes.status}`)
  }
  const geo = (await geoRes.json()) as {
    results?: Array<{ name?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }>
  }
  const place = geo.results?.[0]
  if (!place || place.latitude === undefined || place.longitude === undefined) {
    throw new Error(`city not found: ${name}`)
  }
  const weatherRes = await fetchImpl(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=4',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  )
  if (!weatherRes.ok) {
    throw new Error(`weather HTTP ${weatherRes.status}`)
  }
  const w = (await weatherRes.json()) as {
    current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number }
    daily?: {
      time?: string[]
      weather_code?: number[]
      temperature_2m_max?: number[]
      temperature_2m_min?: number[]
      precipitation_probability_max?: number[]
    }
  }
  const where = [place.name, place.country].filter(Boolean).join(', ')
  const now = w.current ?? {}
  const lines = [
    `${where} (${place.timezone ?? 'local'})`,
    `Now: ${now.temperature_2m ?? '?'}°C, ${describeWeather(now.weather_code)}, humidity ${now.relative_humidity_2m ?? '?'}%, wind ${now.wind_speed_10m ?? '?'} km/h`,
  ]
  const daily = w.daily ?? {}
  for (let i = 1; i <= 3 && daily.time?.[i]; i++) {
    lines.push(
      `${daily.time[i]}: ${describeWeather(daily.weather_code?.[i])}, ${daily.temperature_2m_min?.[i] ?? '?'}~${daily.temperature_2m_max?.[i] ?? '?'}°C, rain ${daily.precipitation_probability_max?.[i] ?? 0}%`,
    )
  }
  return lines.join('\n')
}

/** V8 原生 Intl：任意 IANA 时区的精确本地时间与时差，零外部请求。 */
export function getWorldTime(timeZone: string): string {
  const zone = (timeZone ?? '').trim()
  if (!zone) {
    throw new Error('timezone is required, e.g. Asia/Shanghai')
  }
  const at = new Date()
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(at)
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value
  return `${zone}: ${time} (${offset ?? 'UTC'})`
}

/** QuickChart 之外的零 Key 二维码：qrserver 直接出 PNG。 */
export function buildQrCodeMarkdown(content: string, label = 'QR code'): string {
  const data = (content ?? '').trim()
  if (!data) {
    throw new Error('content is required')
  }
  const safeLabel = label.replace(/[[\]()]/g, '').slice(0, 80) || 'QR code'
  return `![${safeLabel}](https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data)})`
}

export const FREE_TOOL_NAMES = new Set([
  'read_webpage',
  'get_exchange_rate',
  'run_python_calc',
  'generate_chart',
  'fetch_tech_news',
  'get_weather',
  'get_world_time',
  'generate_qr_code',
])

export const builtinFreeTools: ToolDef[] = [
  defineTool({
    name: 'read_webpage',
    description:
      'Read any public web page as clean Markdown through a reader proxy (no API key). Private/local URLs are refused.',
    params: z.object({
      url: z.string().describe('Public http(s) URL'),
      max_chars: z.number().int().min(500).max(6000).optional().describe('Truncation cap, default 4500'),
    }),
    handler: async ({ url, max_chars }, ctx) => {
      try {
        const text = await readWebpageMarkdown(url, max_chars ?? 4500, ctx.budget?.fetch)
        return `# ${url}\n\n${text}`
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'get_exchange_rate',
    description: 'Convert money between currencies using live ECB reference rates (no API key).',
    params: z.object({
      from: z.string().describe('Source currency code, e.g. USD'),
      to: z.string().describe('Target currency code, e.g. CNY'),
      amount: z.number().optional().describe('Amount to convert, default 1'),
    }),
    handler: async ({ from, to, amount }, ctx) => {
      try {
        return await convertCurrency(from, to, amount ?? 1, ctx.budget?.fetch)
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'run_python_calc',
    description:
      'Run a short Python 3.10 snippet in a public sandbox for exact math, unit/volumetric weight, tiered discounts and data analysis.',
    params: z.object({
      code: z.string().describe('Python code; print() the result'),
    }),
    handler: async ({ code }, ctx) => {
      try {
        return await executePythonSandbox(code, ctx.budget?.fetch)
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'fetch_tech_news',
    description: 'Fetch the current top AI/tech headlines from Hacker News (free, no API key). Use for daily briefings.',
    params: z.object({
      limit: z.number().int().min(1).max(30).optional().describe('How many headlines, default 8'),
    }),
    handler: async ({ limit }, ctx) => {
      try {
        const items = await fetchTopTechNews(limit ?? 8, ctx.budget?.fetch)
        if (!items.length) {
          return '(no headlines right now)'
        }
        return items
          .map((n, i) => `${i + 1}. ${n.title}\n${n.url}${n.points ? ` · ${n.points} points` : ''}`)
          .join('\n\n')
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'get_weather',
    description: 'Current weather plus a 3-day forecast for a city, via Open-Meteo (free, no API key).',
    params: z.object({
      city: z.string().describe('City name, e.g. Shanghai or New York'),
    }),
    handler: async ({ city }, ctx) => {
      try {
        return await getCityWeather(city, ctx.budget?.fetch)
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'get_world_time',
    description: 'Exact local time and UTC offset for any IANA timezone (e.g. Asia/Shanghai, America/New_York).',
    params: z.object({
      time_zone: z.string().describe('IANA timezone, e.g. Asia/Shanghai'),
    }),
    handler: async ({ time_zone }) => {
      try {
        return getWorldTime(time_zone)
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'generate_qr_code',
    description: 'Generate a scannable QR code image (Markdown) for any text or link — no API key.',
    params: z.object({
      content: z.string().describe('Text or URL to encode'),
      label: z.string().optional().describe('Alt text / label'),
    }),
    handler: async ({ content, label }) => {
      try {
        return buildQrCodeMarkdown(content, label ?? 'QR code')
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
  defineTool({
    name: 'generate_chart',
    description:
      'Turn a standard Chart.js config (JSON) into a ready-to-render Markdown chart image via QuickChart.',
    params: z.object({
      chart_config: z.string().describe('Chart.js config serialized as JSON'),
      title: z.string().optional().describe('Alt text / chart title'),
    }),
    handler: async ({ chart_config, title }) => {
      try {
        return buildChartMarkdown(chart_config, title ?? 'chart')
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }),
]
