import { describe, expect, it } from 'vitest'
import { selectExtraTools, shouldAttachTools } from '@/agent/tool-intent'

describe('shouldAttachTools', () => {
  it.each(['hi', '你好', '哈喽', '你是谁', 'what can you do', 'thanks!', '早上好'])(
    'keeps tools off for pure chat: %s',
    (text) => {
      expect(shouldAttachTools(text)).toBe(false)
    },
  )

  it.each([
    '帮我搜索今天的 AI 新闻',
    'search the latest news',
    '记住我喜欢喝拿铁',
    'remember my address',
    '看看我的技能',
    '明天的天气怎么样',
    '/daily',
  ])('attaches tools for explicit intent: %s', (text) => {
    expect(shouldAttachTools(text)).toBe(true)
  })

  it.each([
    '你有联网搜索能力吗',
    '你能搜索吗',
    '会不会联网搜索',
    'can you search the web?',
    'do you have internet access',
    '你可以做什么',
  ])('keeps tools off for capability questions: %s', (text) => {
    expect(shouldAttachTools(text)).toBe(false)
  })

  it.each(['I moved to ACME', 'and now?', '巴黎在哪个国家'])('keeps tools on for ordinary talk: %s', (text) => {
    expect(shouldAttachTools(text)).toBe(true)
  })

  it.each([
    ['上海天气怎么样', 'get_weather'],
    ['now in America/New_York timezone', 'get_world_time'],
    ['生成一个联系二维码', 'generate_qr_code'],
    ['今日科技新闻', 'fetch_tech_news'],
    ['画个柱状图', 'generate_chart'],
    ['100 usd 换算成人民币', 'get_exchange_rate'],
    ['帮我算一下体积重', 'run_python_calc'],
  ])('mounts the right extra tool for %s', (text, toolName) => {
    expect(selectExtraTools(text).has(toolName)).toBe(true)
  })

  it('mounts no extras for a plain greeting', () => {
    expect(selectExtraTools('你好').size).toBe(0)
  })

  it('treats a long sentence as a real task even without a keyword', () => {
    expect(shouldAttachTools('帮我把这几段材料整理成一份可以发给客户的草稿，语气专业一点')).toBe(true)
  })
})
