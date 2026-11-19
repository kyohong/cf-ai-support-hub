const GREETING =
  /^(hi|hii|hello|hey|yo|hi there|你好|您好|哈喽|嗨|早上好|早安|晚上好|晚安|在吗|在么|最近怎么样|你好吗|谢谢|多谢|thanks|thank you|thx|ok|okay|bye|再见|拜拜|你是谁|你是做什么的|你可以做什么|你能做什么|who are you|what can you do|what do you do|how are you|good morning|good evening)[!！。.?？~～\s]*$/i

/** 明确的下达动作（祈使句/具体信息诉求）——这些才值得真的调用外部工具。 */
const EXPLICIT_ACTION =
  /(帮我搜|帮我查|搜一下|搜索一下|搜搜|查一下|查查|最新|新闻|热点|热搜|天气|价格|汇率|股票|latest|breaking|news|price|weather|google|look up|search for|调研|research)/i

/** 询问 Agent 自身能力：这类问题只需要介绍自己，不该触发任何外部调用。 */
const CAPABILITY =
  /(能力|会不会|能[^?？。！!\n]{0,12}吗|可以[^?？。！!\n]{0,12}吗|有[^?？。！!\n]{0,10}吗|can you|could you|do you have|are you able|are you capable)/i

const LINK = /https?:\/\//i
const READ_PAGE = /读取网页|网页正文|总结链接|打开链接|看看这个链接|read (this|the) (page|link|url)|summari[sz]e (this|the) (url|link|page)/i
const CURRENCY = /汇率|换算|美金|美元|人民币|欧元|日元|英镑|currency|exchange rate|\b(usd|cny|eur|jpy|gbp)\b/i
const CALC = /计算|算一下|算算|统计|数据分析|\bpython\b|代码|calculate|\bmath\b|compute/i
const CHART = /图表|画图|折线图|柱状图|饼图|\bchart\b|\bplot\b|\bgraph\b/i
const NEWS = /搜索|搜一下|查一下|最新|新闻|头条|早报|资讯|\bsearch\b|\bnews\b|\bbriefing\b|headlines/i
const WEATHER = /天气|气温|下雨|降雨|台风|\bweather\b|\bforecast\b/i
const TIME = /时区|时差|几点|现在.*时间|\btimezone\b|\btime zone\b|\bwhat time\b/i
const QR = /二维码|\bqr\b|qr\s?code/i

/** 分级挂载：内置免费增强工具只在对应意图出现时才挂，避免每条消息都带着 4 个具名工具。
 *  返回空集 = 一个增强工具都不挂；返回的 Set = 要额外挂载的工具名。 */
export function selectExtraTools(message: string): Set<string> {
  const text = (message ?? '').trim()
  const out = new Set<string>()
  if (!text) {
    return out
  }
  if (LINK.test(text) || READ_PAGE.test(text)) {
    out.add('read_webpage')
  }
  if (CURRENCY.test(text)) {
    out.add('get_exchange_rate')
  }
  if (CALC.test(text)) {
    out.add('run_python_calc')
  }
  if (CHART.test(text)) {
    out.add('generate_chart')
  }
  if (NEWS.test(text)) {
    out.add('fetch_tech_news')
  }
  if (WEATHER.test(text)) {
    out.add('get_weather')
  }
  if (TIME.test(text)) {
    out.add('get_world_time')
  }
  if (QR.test(text)) {
    out.add('generate_qr_code')
  }
  return out
}

/** 轻量意图门控（Intent Gate）：
 *  - 明确动作指令 → 挂工具（search 等）优先判定；
 *  - 询问"你有搜索能力吗/你能搜索吗/can you search" → 纯文本介绍自己，不调工具；
 *  - 纯寒暄/致谢/自我介绍 → 纯文本秒回；
 *  - 其余消息保留工具——事实陈述（"I moved to ACME"）本身就该触发主动记忆。 */
export function shouldAttachTools(message: string): boolean {
  const text = (message ?? '').trim()
  if (!text) {
    return false
  }
  if (text.startsWith('/')) {
    return true
  }
  if (EXPLICIT_ACTION.test(text)) {
    return true
  }
  if (CAPABILITY.test(text)) {
    return false
  }
  return !GREETING.test(text)
}
