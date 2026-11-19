import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  assertPublicUrl,
  buildQrCodeMarkdown,
  getWorldTime,
  smartWebSearch,
} from '@/tools/builtin-free-tools'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

describe('assertPublicUrl', () => {
  it.each(['http://localhost/x', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.20.0.1/'])(
    'refuses private targets: %s',
    (url) => {
      expect(() => assertPublicUrl(url)).toThrow(/private or local/)
    },
  )

  it('refuses non-http schemes', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(/http/)
  })

  it('accepts a public https URL', () => {
    expect(assertPublicUrl('https://example.com/p/1').hostname).toBe('example.com')
  })
})

describe('smartWebSearch', () => {
  it('uses the Brave key tier when configured', async () => {
    fetchMock
      .get('https://api.search.brave.com')
      .intercept({ method: 'GET', path: /\/res\/v1\/web\/search/ })
      .reply(
        200,
        { web: { results: [{ title: 'B hit', url: 'https://b.example/', description: 'brave snippet' }] } },
        { headers: { 'content-type': 'application/json' } },
      )
    const out = await smartWebSearch('x', { braveApiKey: 'brave-key' }, 5)
    expect(out.hits[0]).toMatchObject({ title: 'B hit', url: 'https://b.example/' })
    expect(out.attempts[0]).toBe('brave')
  })

  it('never throws when every tier fails, and says nothing responded', async () => {
    fetchMock
      .get('https://html.duckduckgo.com')
      .intercept({ method: 'GET', path: /html\// })
      .reply(500, 'down')
    fetchMock
      .get('https://en.wikipedia.org')
      .intercept({ method: 'GET', path: /w\/api\.php/ })
      .reply(500, 'down')
    fetchMock
      .get('https://hn.algolia.com')
      .intercept({ method: 'GET', path: /v1\/search/ })
      .reply(500, 'down')
    const out = await smartWebSearch('x', {}, 5)
    expect(out.hits).toEqual([])
    expect(out.responded).toBe(false)
    expect(out.errors.length).toBeGreaterThan(0)
  })

  it('uses the HackerNews tier as the last resort', async () => {
    fetchMock
      .get('https://html.duckduckgo.com')
      .intercept({ method: 'GET', path: /html\// })
      .reply(429, 'limited')
    fetchMock
      .get('https://en.wikipedia.org')
      .intercept({ method: 'GET', path: /w\/api\.php/ })
      .reply(200, { query: { search: [] } }, { headers: { 'content-type': 'application/json' } })
    fetchMock
      .get('https://hn.algolia.com')
      .intercept({ method: 'GET', path: /v1\/search/ })
      .reply(
        200,
        { hits: [{ title: 'HN story', url: 'https://hn.example/', story_text: 'text' }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const out = await smartWebSearch('x', {}, 5)
    expect(out.hits[0]?.url).toBe('https://hn.example/')
  })
})

describe('zero-key helpers', () => {
  it('renders an IANA timezone with its UTC offset', () => {
    const out = getWorldTime('Asia/Shanghai')
    expect(out).toContain('Asia/Shanghai')
    expect(out).toMatch(/GMT\+0?8/)
  })

  it('refuses an invalid timezone instead of returning nonsense', () => {
    expect(() => getWorldTime('Mars/Olympus')).toThrow(/Invalid time zone|RangeError/i)
  })

  it('encodes the QR content into the image URL', () => {
    const md = buildQrCodeMarkdown('https://example.com/?a=1', 'Contact')
    expect(md).toContain('![Contact](https://api.qrserver.com/v1/create-qr-code/')
    expect(md).toContain(encodeURIComponent('https://example.com/?a=1'))
  })

  it('keeps the worker env reachable for future fixtures', () => {
    expect(env).toBeDefined()
  })
})
