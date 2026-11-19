import { Agent, callable, getAgentByName } from 'agents'
import type OpenAI from 'openai'
import type { SqlTag } from '@/agent/memory/embedding-index'
import { threadOf, webAgentName, WEB_IDENTITY } from '@/agent/agent-name'
import { INDEX_INSTANCE } from '@/agent/maintenance-agent'
import { createMemoryStore } from '@/agent/memory/vault-store'
import {
  appendArchive,
  dropArchive,
  readArchive,
  toolArchiveOver,
  type CompactionRecord,
  type FeedbackRecord,
} from '@/agent/archive'
import { historyForTurn, isContextOverflow, pairedOnly, spoken } from '@/agent/loop/context-window'
import * as compaction from '@/agent/loop/history-compaction'
import { mcpRegistry } from '@/agent/mcp/registry'
import type { McpClientRpc } from '@/agent/mcp/client'
import { buildMcpTools } from '@/agent/mcp/tools'
import { verdictFor, type CitationVerdict } from '@/agent/provenance'
import { buildSystemPrompt, renderSkillIndex } from '@/agent/system-prompt'
import { selectExtraTools, shouldAttachTools } from '@/agent/tool-intent'
import { FREE_TOOL_NAMES } from '@/tools/builtin-free-tools'
import { contentEnabled, createLog, describeError, errorFields, ORPHAN_LOG, type LogSource, type TurnLog } from '@/agent/log'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from '@/agent/subrequest-budget'
import { applySubrequestLimit } from '@/agent/workers-plan'
import * as research from '@/agent/research/commands'
import { runToolLoop, toHistoryMessage, turnToolTraffic, type StopReason } from '@/agent/loop/tool-loop'
import { throttle } from '@/agent/throttle'
import { buildTools } from '@/agent/tools'
import type { ToolContext, ToolDef } from '@/agent/tools/registry'
import { briefingPrompt, BRIEFING_DEFAULT_KEYWORDS, publishBriefing } from '@/agent/briefing'
import { mask, readNotifySettings } from '@/agent/notify'
import {
  applyAdvancedInput,
  clientForRoute,
  forceViaAiRoute,
  isWorkersAiModel,
  readAdvancedSettings,
  resolveLlmRoute,
  testCustomApi,
  toSettingsView,
  type LlmRoute,
} from '@/agent/advanced-config'
import type { NotifySettings } from '@/agent/memory/memory-store'
import type {
  AdvancedSettingsInput,
  AdvancedSettingsView,
  AgentState,
  ApiTestResult,
  BriefingPayload,
  ChatMessage,
  DashboardData,
  Env,
  HistoryMessage,
  MemoryWall,
  ReminderPayload,
  ResearchPreset,
  ScoutCounts,
  TaskPayload,
  WebMessagePayload,
} from '@/types'

interface TurnOutcome {
  reply: string
  stopReason: StopReason
  roundsUsed: number
  toolsUsed: string[]
  elapsedMs: number
  tokensSpent: number
  mcpTools: number
}

function turnFields(o: TurnOutcome) {
  return {
    outcome: 'ok',
    stopReason: o.stopReason,
    roundsUsed: o.roundsUsed,
    toolsUsed: o.toolsUsed,
    elapsedMs: o.elapsedMs,
    tokensSpent: o.tokensSpent,
    mcpTools: o.mcpTools,
  }
}

type ChainCallback = 'runResearchRound' | 'runCompactHistory'

function toChatMessages(history: HistoryMessage[], log?: TurnLog): ChatMessage[] {
  return pairedOnly(history, log).map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls }
    }
    return { role: m.role, content: m.content }
  })
}

const SKILL_COMMAND_RE = /^\/([a-z][\w-]{1,63})(?:@\w+)?(?:\s+([\s\S]+))?$/i

const DRAFT_BROADCAST_MS = 250

// Cloudflare Workers Free plan daily ceilings, the denominators of the dashboard progress bar.
const FREE_DAILY_REQUESTS = 100_000
const FREE_DAILY_NEURONS = 10_000

/** Landing is a real thread id ('main') that is never shown in the thread list and never deleted —
 *  which makes its Durable Object the one safe home for global state: daily usage counters,
 *  briefing schedules, and the dashboard numbers. */
export class PersonalAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { messages: [] }
  // `protected` on DurableObject; `declare` widens it without emitting a field over the base one.
  declare env: Env

  private isLanding(): boolean {
    try {
      return threadOf(this.name) === 'main'
    } catch {
      // PartyServer throws on `this.name` when the DO was not addressed by name (tests, direct
      // ids). An unnamed instance is never the landing, so the caller just runs the fallback.
      return false
    }
  }

  private landing(): PersonalAgent {
    return this.isLanding() ? this : (this.env.PERSONAL_AGENT.get(this.env.PERSONAL_AGENT.idFromName(webAgentName(WEB_IDENTITY, undefined))) as unknown as PersonalAgent)
  }

  /** Last route resolved by `llm()` / `prepareRouting()`. Not a cache: every call re-reads the vault
   *  so a settings change takes effect on the next turn instead of when the instance restarts. */
  private route: LlmRoute | null = null
  private soulPrompt = ''

  /** Resolves the model route and the user's soul prompt without building a client. Research calls
   *  this before fanning out so scouts inherit the same provider and model. */
  async prepareRouting(): Promise<void> {
    const adv = await readAdvancedSettings(this.env)
    this.soulPrompt = adv.soulPrompt.trim()
    this.route = await resolveLlmRoute(this.env, adv)
  }

  get customRouting(): boolean {
    return !!this.route?.custom
  }

  async llm(budget: SubrequestBudget): Promise<OpenAI> {
    let route: LlmRoute
    try {
      await this.prepareRouting()
      route = this.route ?? forceViaAiRoute(this.env.LLM_MODEL)
    } catch (err) {
      // 路由解析失败绝不杀掉整轮对话：退回 env.AI 绑定（无需任何凭据），并留完整堆栈。
      console.error('[llm] route resolution failed, falling back to the env.AI binding:', err)
      this.soulPrompt = ''
      route = forceViaAiRoute(this.env.LLM_MODEL)
    }
    // 最高优先级规则：@cf/@hf 模型 100% 强制走 env.AI 绑定，customApiEnabled 与 LLM_BASE_URL 无权覆盖。
    const wanted = this.state.modelOverride ?? this.env.LLM_MODEL
    if (isWorkersAiModel(wanted)) {
      route = forceViaAiRoute(wanted)
      this.route = route
    }
    return clientForRoute(this.env, route, budget.fetch, () => budget.charge())
  }

  @callable()
  async getAdvancedSettings(): Promise<AdvancedSettingsView> {
    return toSettingsView(await readAdvancedSettings(this.env))
  }

  @callable()
  async saveAdvancedSettings(input: AdvancedSettingsInput): Promise<AdvancedSettingsView> {
    const store = createMemoryStore(this.env)
    const next = applyAdvancedInput(await store.getAdvancedSettings(), input)
    await store.saveAdvancedSettings(next)
    this.route = null
    await this.prepareRouting()
    return toSettingsView(next)
  }

  @callable()
  async testCustomApiConnection(input: AdvancedSettingsInput): Promise<ApiTestResult> {
    return testCustomApi(this.env, input)
  }

  private usageKey(day: string): string {
    return `${this.env.VAULT_AGENT_DIR}/usage/${day}.json`
  }

  private async reportUsage(tokens: number): Promise<void> {
    // One small JSON per UTC day in the vault. Not DO SQLite: a thread's turn runs on the thread's
    // own Durable Object, a namespace cannot be enumerated, and a per-turn DO-to-DO RPC would spend
    // one of the Free plan's 50 daily subrequests — while an R2 binding call spends none. A
    // concurrent turn can lose one increment; the dashboard is an estimate, accepted.
    try {
      const day = new Date().toISOString().slice(0, 10)
      const obj = await this.env.VAULT.get(this.usageKey(day))
      const prev = obj ? (JSON.parse(await obj.text()) as { requests?: number; neurons?: number }) : {}
      const next = {
        requests: (prev.requests ?? 0) + 1,
        neurons: (prev.neurons ?? 0) + Math.ceil(Math.max(0, tokens) / 1000),
      }
      await this.env.VAULT.put(this.usageKey(day), JSON.stringify(next))
    } catch (err) {
      console.log(JSON.stringify({ at: 'usage', stage: 'bump-failed', error: String(err) }))
    }
  }

  private async readUsage(day: string): Promise<{ requests: number; neurons: number }> {
    try {
      const obj = await this.env.VAULT.get(this.usageKey(day))
      const parsed = obj ? (JSON.parse(await obj.text()) as { requests?: number; neurons?: number }) : {}
      return { requests: parsed.requests ?? 0, neurons: parsed.neurons ?? 0 }
    } catch {
      return { requests: 0, neurons: 0 }
    }
  }

  @callable()
  async getDashboard(): Promise<DashboardData> {
    if (!this.isLanding()) {
      return this.landing().getDashboard()
    }
    const day = new Date().toISOString().slice(0, 10)
    const store = createMemoryStore(this.env)
    const [index, skills, notify, briefing] = await Promise.all([
      store.list(),
      store.listSkills().catch(() => []),
      readNotifySettings(this.env).catch(() => ({}) as NotifySettings),
      this.briefingSchedule(),
    ])
    const row = await this.readUsage(day)
    return {
      usage: {
        requests: row.requests,
        requestsLimit: FREE_DAILY_REQUESTS,
        neurons: row.neurons,
        neuronsLimit: FREE_DAILY_NEURONS,
      },
      memoryCount: index.split('\n').filter((l) => l.startsWith('- ')).length,
      skillCount: skills.length,
      nextBriefingAt: briefing?.nextAt ?? null,
      briefingTime: briefing?.time ?? null,
      briefingKeywords: briefing?.keywords ?? BRIEFING_DEFAULT_KEYWORDS,
      notify: { feishu: mask(notify.feishu), telegram: mask(notify.telegramToken) },
    }
  }

  private async briefingSchedule(): Promise<{ nextAt: number; time: string; keywords: string } | null> {
    const s = (await this.listSchedules())
      .filter((x) => x.callback === 'runBriefing')
      .sort((a, b) => a.time - b.time)[0] as { time: number; payload?: BriefingPayload } | undefined
    if (!s) {
      return null
    }
    const d = new Date(s.time * 1000)
    return {
      nextAt: s.time * 1000,
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      keywords: s.payload?.keywords?.trim() || BRIEFING_DEFAULT_KEYWORDS,
    }
  }

  @callable()
  async listMemoryWall(): Promise<MemoryWall> {
    if (!this.isLanding()) {
      return this.landing().listMemoryWall()
    }
    const store = createMemoryStore(this.env)
    const index = await store.list()
    const memories = index
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => {
        const rest = l.slice(2)
        const sep = rest.indexOf(' — ')
        return { slug: sep >= 0 ? rest.slice(0, sep) : rest, description: sep >= 0 ? rest.slice(sep + 3) : '' }
      })
    const skills = (await store.listSkills().catch(() => [])).map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      useCount: s.useCount,
    }))
    return { memories, skills }
  }

  @callable()
  async saveNotifySettings(settings: NotifySettings): Promise<void> {
    if (!this.isLanding()) {
      await this.landing().saveNotifySettings(settings)
      return
    }
    await createMemoryStore(this.env).saveNotifySettings({
      feishu: settings.feishu?.trim() || undefined,
      telegramToken: settings.telegramToken?.trim() || undefined,
      telegramChat: settings.telegramChat?.trim() || undefined,
    })
  }

  @callable()
  async configureBriefing(time: string, keywords: string): Promise<{ nextAt: number | null }> {
    if (!this.isLanding()) {
      return this.landing().configureBriefing(time, keywords)
    }
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
    if (!m) {
      throw new Error('时间格式必须是 HH:MM')
    }
    for (const s of await this.listSchedules()) {
      if (s.callback === 'runBriefing') {
        await this.cancelSchedule(s.id)
      }
    }
    const s = await this.schedule(`${m[2]} ${Number(m[1])} * * *`, 'runBriefing', {
      keywords: keywords.trim(),
    } satisfies BriefingPayload)
    return { nextAt: s.time * 1000 }
  }

  @callable()
  async runBriefingNow(): Promise<void> {
    if (!this.isLanding()) {
      await this.landing().runBriefingNow()
      return
    }
    const configured = (await this.listSchedules()).find((s) => s.callback === 'runBriefing')
    await this.schedule(0, 'runBriefing', (configured?.payload as BriefingPayload | undefined) ?? {})
  }

  async runBriefing(payload?: BriefingPayload): Promise<void> {
    const log = this.newLog('schedule')
    const keywords = payload?.keywords?.trim() || BRIEFING_DEFAULT_KEYWORDS
    const title = `每日早报 · ${new Date().toISOString().slice(0, 10)}`
    try {
      const { text, stopReason, tokensSpent, subrequests } = await this.runAgentic(briefingPrompt(keywords), log)
      log.event({ at: 'briefing', outcome: 'ok', stopReason, subrequests })
      await this.reportUsage(tokensSpent)
      const results = await publishBriefing(this.env, title, text)
      const pushed = results.length ? `\n\n———\n已推送到: ${results.join('，')}` : '\n\n———\n尚未配置推送渠道（设置 → 消息推送）'
      await this.emit(`📰 ${title}\n\n${text}${pushed}`)
    } catch (err) {
      log.error({ at: 'briefing', outcome: 'error', error: errorFields(err) })
      await this.emit('⚠️ 早报生成失败，请稍后重试或检查日志。')
    }
  }

  private assertDevOnly(entrypoint: string): void {
    if (this.env.ENVIRONMENT !== 'localhost') {
      throw new Error(`${entrypoint} is localhost-only`)
    }
  }

  async seedState(state: AgentState): Promise<void> {
    this.assertDevOnly('seedState')
    this.setState(state)
  }

  async handleUserMessage(text: string, modelOverride?: string): Promise<string> {
    this.assertDevOnly('handleUserMessage')
    const budget = this.budget()
    const log = this.newLog('dev')
    const outcome = await this.generateReply(text, budget, log, { modelOverride })
    log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    return outcome.reply
  }

  async registerThread(firstText: string, log: TurnLog): Promise<void> {
    const id = threadOf(this.name)
    if (!id) {
      return
    }
    try {
      const untitled = !this.state.messages.some((m) => m.role === 'user')
      const title = untitled ? firstText.replace(/\s+/g, ' ').slice(0, 60) : undefined
      await createMemoryStore(this.env).touchThread(id, title)
    } catch (err) {
      log.error({ at: 'thread', stage: 'register-failed', thread: id, error: errorFields(err) })
    }
  }

  @callable()
  async enqueueWebMessage(text: string): Promise<void> {
    const log = this.newLog('schedule')
    await this.registerThread(text, log)
    const entry: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry], status: 'thinking' })
    await this.schedule(0, 'processWebMessage', { text, id: entry.id } satisfies WebMessagePayload)
  }

  @callable()
  async renameThread(title: string): Promise<void> {
    const id = threadOf(this.name)
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!id || !clean) {
      return
    }
    await createMemoryStore(this.env).renameThread(id, clean)
  }

  @callable()
  async deleteThread(): Promise<void> {
    const id = threadOf(this.name)
    const log = this.newLog('schedule')
    for (const s of await this.listSchedules()) {
      await this.cancelSchedule(s.id)
    }
    dropArchive(this.archiveSql)
    this.setState({ ...this.initialState })
    if (!id) {
      return
    }
    try {
      await createMemoryStore(this.env).removeThread(id)
    } catch (err) {
      log.error({ at: 'thread', stage: 'delete-failed', thread: id, error: errorFields(err) })
    }
  }

  async processWebMessage(payload: WebMessagePayload): Promise<void> {
    const budget = this.budget()
    const log = this.newLog('web')
    try {
      const userMessageId = payload.id ?? this.state.messages.at(-1)?.id
      const outcome = await this.generateReply(payload.text, budget, log, { userMessageId })
      await this.reportUsage(outcome.tokensSpent)
      await this.clearStatusIfIdle(payload.id)
      log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    } catch (err) {
      // 完整堆栈进日志（Workers 控制台 tail 可见），简短原因直接给到前端，故障点一目了然。
      console.error('[turn] answering failed:', err)
      const reason = describeError(err)
      this.setState({ ...this.state, live: undefined, draft: undefined })
      await this.clearStatusIfIdle(payload.id)
      log.error({
        at: 'turn',
        outcome: 'error',
        stopReason: 'error',
        subrequests: budget.spent,
        error: errorFields(err),
      })
      await this.emit(
        `Sorry — I hit a problem answering that. Please try again.\n\n(Error: ${reason.slice(0, 300)})`,
      )
    }
  }

  async clearStatusIfIdle(mine?: string): Promise<void> {
    const pending = (await this.listSchedules()) as { callback: string; payload?: WebMessagePayload }[]
    const queued = pending.some((s) => s.callback === 'processWebMessage' && s.payload?.id !== mine)
    if (!queued) {
      this.setState({ ...this.state, status: undefined })
    }
  }

  private planLimit = FREE_PLAN_SUBREQUESTS

  budget(): SubrequestBudget {
    return new SubrequestBudget(this.planLimit)
  }

  async onStart(): Promise<void> {
    void applySubrequestLimit(this.ctx.storage, this.env, (limit) => (this.planLimit = limit), this.newLog('schedule'))
    if (!this.state.status) {
      return
    }
    const pending = await this.listSchedules()
    const working = pending.some((s) => s.callback === 'processWebMessage' || s.callback === 'runCompactHistory')
    if (working) {
      return
    }
    this.newLog('schedule').event({ at: 'turn', stage: 'status-orphaned', status: this.state.status })
    this.setState({ ...this.state, status: undefined, live: undefined, draft: undefined })
  }

  @callable()
  async setModel(id: string | null): Promise<void> {
    const log = this.newLog('web')
    this.setState({ ...this.state, modelOverride: id ?? undefined })
    await this.emit(id ? `Model switched to ${id}` : `Back to the default model (${this.env.LLM_MODEL}).`)
    await compaction.resolveContextWindow(this, this.budget(), log)
    await compaction.maybeCompactHistory(this, log)
  }

  async emit(text: string): Promise<void> {
    const entry: HistoryMessage = { role: 'assistant', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry] })
    await compaction.maybeCompactHistory(this, ORPHAN_LOG)
  }

  private sessionStarted(): boolean {
    return this.state.messages.some((m) => m.role === 'user')
  }

  private async loadUserProfile(log: TurnLog = ORPHAN_LOG): Promise<string> {
    if (this.sessionStarted() && this.state.userProfile !== undefined) {
      return this.state.userProfile
    }
    try {
      const profile = await createMemoryStore(this.env).getUserProfile()
      this.setState({ ...this.state, userProfile: profile })
      return profile
    } catch (err) {
      log.error({ at: 'profile-load', degraded: true, error: errorFields(err) })
      return this.state.userProfile ?? ''
    }
  }

  private async loadAgentNotes(log: TurnLog = ORPHAN_LOG): Promise<string> {
    if (this.sessionStarted() && this.state.agentNotes !== undefined) {
      return this.state.agentNotes
    }
    try {
      const notes = await createMemoryStore(this.env).getAgentNotes()
      this.setState({ ...this.state, agentNotes: notes })
      return notes
    } catch (err) {
      log.error({ at: 'agent-notes-load', degraded: true, error: errorFields(err) })
      return this.state.agentNotes ?? ''
    }
  }

  private async loadSkillIndex(log: TurnLog): Promise<string> {
    try {
      return renderSkillIndex(await createMemoryStore(this.env).listSkills())
    } catch (err) {
      log.error({ at: 'skill-index-load', degraded: true, error: errorFields(err) })
      return ''
    }
  }

  maintenance() {
    return this.env.MAINTENANCE.get(this.env.MAINTENANCE.idFromName(INDEX_INSTANCE))
  }

  private async turnTools(log: TurnLog, extras?: Set<string>): Promise<{ tools: ToolDef[]; mcpTools: number }> {
    const native = buildTools().filter((t) => !FREE_TOOL_NAMES.has(t.name) || !extras || extras.has(t.name))
    try {
      const catalog = await mcpRegistry(this.env).listTools()
      const mcp = buildMcpTools(
        catalog,
        async (serverId, name, args) => {
          const client = (await getAgentByName(this.env.MCP_CLIENT, serverId)) as unknown as McpClientRpc
          return client.callTool(name, args)
        },
        native.map((t) => t.name),
        log,
      )
      return { tools: [...native, ...mcp], mcpTools: mcp.length }
    } catch (err) {
      log.error({ at: 'mcp', stage: 'catalog-failed', error: errorFields(err) })
      return { tools: native, mcpTools: 0 }
    }
  }

  toolContext(budget?: SubrequestBudget, log?: TurnLog, turn?: HistoryMessage): ToolContext {
    const thisThread = threadOf(this.name) ?? this.name
    return {
      env: this.env,
      pageCache: new Map(),
      agent: this as never,
      index: this.maintenance(),
      budget,
      log,
      source: { thread: thisThread, ...(turn ? { turn: turn.id } : {}), at: Date.now() },
      verifyCitation: async (thread, cited) => {
        if (thread !== thisThread) {
          return { ok: false, why: 'missing' }
        }
        if (turn && cited === turn.id) {
          return verdictFor(turn)
        }
        return this.verifyCitation(cited)
      },
      pendingReport: () => this.state.research?.report,
      toolArchive: toolArchiveOver(this.archiveSql),
      contextTokens: this.windowFor(this.model),
    }
  }

  private async resolveSkillInvocation(text: string, log: TurnLog = ORPHAN_LOG): Promise<string> {
    const m = text.trim().match(SKILL_COMMAND_RE)
    if (!m) {
      return text
    }
    const slug = m[1].toLowerCase().replaceAll('_', '-')
    try {
      const skill = await createMemoryStore(this.env).readSkill(slug)
      if (!skill) {
        return text
      }
      return [
        'Apply this saved skill to handle my request.',
        `<skill name="${skill.name.replaceAll('"', "'")}">`,
        skill.content,
        '</skill>',
        '',
        `Request: ${m[2]?.trim() || '(no extra instruction — follow the skill as written)'}`,
      ].join('\n')
    } catch (err) {
      log.error({ at: 'skill-lookup', degraded: true, error: errorFields(err) })
      return text
    }
  }

  private async generateReply(
    text: string,
    budget: SubrequestBudget,
    log: TurnLog,
    opts: { modelOverride?: string; userMessageId?: string } = {},
  ): Promise<TurnOutcome> {
    try {
      return await this.runTurn(text, budget, log, opts)
    } catch (err) {
      if (!isContextOverflow(err)) {
        throw err
      }
      log.event({ at: 'compact', stage: 'overflow-retry', model: this.model })
      await compaction.compactHistory(this, log, { force: true, budget })
      return this.runTurn(text, budget, log, opts)
    }
  }

  private async runTurn(
    text: string,
    budget: SubrequestBudget,
    log: TurnLog,
    opts: { modelOverride?: string; userMessageId?: string } = {},
  ): Promise<TurnOutcome> {
    const resolved = await this.resolveSkillInvocation(text, log)
    const at = opts.userMessageId ? this.state.messages.findIndex((m) => m.id === opts.userMessageId) : -1
    const persistedUser = at >= 0 ? this.state.messages[at] : undefined
    const ownTurn: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    const withUser: HistoryMessage[] = persistedUser
      ? historyForTurn(this.state.messages, at, { ...persistedUser, content: resolved })
      : [...this.state.messages, { ...ownTurn, content: resolved }]

    const outgoing = toChatMessages(withUser, log)

    const startedAt = Date.now()
    const client = await this.llm(budget)
    const extras = selectExtraTools(resolved)
    const { tools, mcpTools } = shouldAttachTools(resolved)
      ? await this.turnTools(log, extras)
      : { tools: [], mcpTools: 0 }
    let live: HistoryMessage[] = []
    const draft = throttle<string>(DRAFT_BROADCAST_MS, (text) => this.setState({ ...this.state, draft: text }))
    const {
      text: reply,
      toolsUsed,
      stopReason,
      roundsUsed,
      promptTokens,
      tokensSpent,
      messages: loopMessages,
    } = await runToolLoop({
      client,
      model: opts.modelOverride ?? this.model,
      systemPrompt: buildSystemPrompt(
        await this.loadUserProfile(log),
        await this.loadAgentNotes(log),
        await this.loadSkillIndex(log),
        this.state.historySummary,
        this.soulPrompt,
      ),
      history: outgoing,
      tools,
      ctx: this.toolContext(budget, log, opts.userMessageId ? persistedUser : ownTurn),
      subrequests: budget,
      log,
      onText: draft.push,
      onMessage: (m) => {
        draft.cancel()
        live = [...live, toHistoryMessage(m, Date.now())]
        this.setState({ ...this.state, live, draft: undefined })
      },
    }).finally(() => draft.cancel())

    const combined: HistoryMessage[] = [
      ...this.state.messages,
      ...(opts.userMessageId ? [] : [ownTurn]),
      ...turnToolTraffic(loopMessages, outgoing.length, Date.now(), log),
      {
        role: 'assistant',
        content: reply,
        id: crypto.randomUUID(),
        at: Date.now(),
        ...(toolsUsed.length ? { tools: toolsUsed } : {}),
        ...(tokensSpent ? { tokens: tokensSpent } : {}),
      },
    ]

    this.setState({
      ...this.state,
      messages: combined,
      live: undefined,
      draft: undefined,
      promptTokens,
      ...(toolsUsed.includes('update_user_profile') ? { userProfile: undefined } : {}),
      ...(toolsUsed.includes('update_agent_notes') ? { agentNotes: undefined } : {}),
    })
    await compaction.maybeCompactHistory(this, log)
    return {
      reply,
      stopReason,
      roundsUsed,
      toolsUsed,
      tokensSpent,
      elapsedMs: Date.now() - startedAt,
      mcpTools,
    }
  }

  @callable()
  async rateMessage(messageId: string, rating: 'up' | 'down' | 'none', note?: string): Promise<void> {
    const message = await this.resolveTurn(messageId)
    if (!message || message.role !== 'assistant') {
      this.newLog('web').error({ at: 'feedback', stage: 'unratable', message: messageId })
      throw new Error(`cannot rate ${messageId}: not an assistant turn in this thread`)
    }
    appendArchive(this.archiveSql, 'feedback', {
      message: messageId,
      rating,
      ...(note?.trim() ? { note: note.trim() } : {}),
    } satisfies FeedbackRecord)
    this.newLog('web').event({ at: 'feedback', rating, message: messageId, noted: !!note?.trim() })
  }

  async verifyCitation(turn: string): Promise<CitationVerdict> {
    return verdictFor(await this.resolveTurn(turn))
  }

  async resolveTurn(id: string): Promise<HistoryMessage | null> {
    const live = this.state.messages.find((m) => m.id === id)
    if (live) {
      return live
    }
    for (const row of readArchive<CompactionRecord>(this.archiveSql)) {
      if (row.type !== 'compaction') {
        continue
      }
      const found = row.data.evicted.find((m) => m.id === id)
      if (found) {
        return found
      }
    }
    return null
  }

  async recentActivity(since: number): Promise<HistoryMessage[]> {
    const archived = readArchive<CompactionRecord>(this.archiveSql, since)
      .filter((r) => r.type === 'compaction')
      .flatMap((r) => r.data.evicted)
    const byId = new Map<string, HistoryMessage>()
    const messages = spoken([...archived, ...this.state.messages])
    for (const m of messages) {
      if ((m.at ?? 0) > since && !byId.has(m.id)) {
        byId.set(m.id, m)
      }
    }
    return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  }

  async fireReminder(payload: ReminderPayload): Promise<void> {
    try {
      await this.emit(`⏰ ${payload.text}`)
    } catch (err) {
      this.newLog('schedule').error({ at: 'reminder', outcome: 'error', error: errorFields(err) })
    }
  }

  async runTask(payload: TaskPayload): Promise<void> {
    const log = this.newLog('schedule')
    try {
      const { text, tokensSpent, subrequests } = await this.runAgentic(payload.prompt, log)
      log.event({ at: 'task', outcome: 'ok', subrequests })
      await this.reportUsage(tokensSpent)
      await this.emit(text)
    } catch (err) {
      log.error({
        at: 'task',
        outcome: 'error',
        stopReason: 'error',
        error: errorFields(err),
      })
      await this.emit('⚠️ Scheduled task failed. Check logs.')
    }
  }

  /** One scheduled agentic turn: the tool loop over a single prompt, with the same memory and
   *  tools a web turn would get. Shared by `runTask` and the briefing. */
  private async runAgentic(
    prompt: string,
    log: TurnLog,
  ): Promise<{ text: string; stopReason: StopReason; tokensSpent: number; subrequests: number }> {
    const budget = this.budget()
    const client = await this.llm(budget)
    const { tools } = await this.turnTools(log)
    const { text, stopReason, tokensSpent } = await runToolLoop({
      log,
      client,
      model: this.model,
      systemPrompt: buildSystemPrompt(
        await this.loadUserProfile(log),
        await this.loadAgentNotes(log),
        await this.loadSkillIndex(log),
        this.state.historySummary,
        this.soulPrompt,
      ),
      history: [{ role: 'user', content: prompt }],
      tools,
      ctx: this.toolContext(budget, log),
      subrequests: budget,
    })
    return { text, stopReason, tokensSpent, subrequests: budget.spent }
  }

  windowFor(model: string): number | undefined {
    return model === this.state.contextModel ? this.state.contextTokens : undefined
  }

  get archiveSql(): SqlTag {
    return this.sql.bind(this) as SqlTag
  }

  get model(): string {
    const wanted = this.state.modelOverride ?? this.env.LLM_MODEL
    if (isWorkersAiModel(wanted)) {
      return wanted
    }
    if (this.route?.custom && this.route.model) {
      return this.route.model
    }
    return wanted
  }

  async runCompactHistory(): Promise<void> {
    await compaction.compactHistory(this, this.newLog('schedule'))
  }

  @callable()
  async compactNow(): Promise<void> {
    await compaction.compactHistory(this, this.newLog('web'), { force: true })
  }

  newLog(source: LogSource): TurnLog {
    return createLog(source, { content: contentEnabled(this.env) })
  }

  @callable()
  async proposeResearch(topic: string): Promise<void> {
    await research.proposeResearch(this, topic)
  }

  @callable()
  async revisePlan(note: string): Promise<void> {
    await research.revisePlan(this, note)
  }

  @callable()
  async startResearch(preset: ResearchPreset = 'normal'): Promise<void> {
    await research.startResearch(this, preset)
  }

  @callable()
  async stopResearch(): Promise<void> {
    await research.stopResearch(this)
  }

  @callable()
  async saveResearch(): Promise<void> {
    await research.saveResearch(this)
  }

  async scoutProgress(runId: string, angle: string, counts: ScoutCounts): Promise<void> {
    research.scoutProgress(this, runId, angle, counts)
  }

  async runResearchRound(): Promise<void> {
    await research.runResearchRound(this)
  }

  async scheduleChain(callback: ChainCallback, seconds: number): Promise<void> {
    await this.cancelChain(callback)
    await this.schedule(seconds, callback, undefined)
  }

  async cancelChain(callback: ChainCallback): Promise<void> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === callback)
    await Promise.all(pending.map((s) => this.cancelSchedule(s.id)))
  }
}
