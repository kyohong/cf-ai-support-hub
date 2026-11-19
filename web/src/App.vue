<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { Loader } from '@/components/ai-elements/loader'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import type { ToolState } from '@/components/ai-elements/ai-types'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMediaQuery, useStorage } from '@vueuse/core'
import { ChevronDownIcon, MenuIcon, PlusIcon, XIcon } from '@lucide/vue'
import ContextMeter from '@/components/ContextMeter.vue'
import MessageFeedback from '@/components/MessageFeedback.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import ModePicker from '@/components/ModePicker.vue'
import ThemePicker from '@/components/ThemePicker.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import LocaleToggle from '@/components/LocaleToggle.vue'
import BotHub from '@/components/BotHub.vue'
import DashboardBar from '@/components/DashboardBar.vue'
import MemoryWall from '@/components/MemoryWall.vue'
import WelcomePanel from '@/components/WelcomePanel.vue'
import ThreadSidebar from '@/components/ThreadSidebar.vue'
import Toaster from '@/components/Toaster.vue'
import ResearchProposal from '@/components/ResearchProposal.vue'
import ResearchRunning from '@/components/ResearchRunning.vue'
import ResearchReport from '@/components/ResearchReport.vue'
import { contextUsage, formatTokens, wouldCompact } from '@/lib/context'
import { groupTurns, type ToolStep } from '@agent/agent/loop/turns'
import type { ToolCall } from '@agent/types/chat'
import { useAgent } from '@/useAgent'
import { LANDING, useThreads } from '@/useThreads'
import { t } from '@/i18n'
import type { ChatMode, ModelRow } from '@/types'

const { threads, current, closed, open, create, refresh } = useThreads()
const {
  state,
  connected,
  loaded,
  say,
  setModel,
  research: run,
  deleteThread,
  renameThread,
  compactNow,
  rateMessage,
} = useAgent(current, closed)

async function rename(title: string): Promise<void> {
  if (await renameThread(title)) {
    await refresh()
  }
}

/** Deleting is the one irreversible thing in this UI — the history goes and the vault row with it —
 *  and it sits under a hover-revealed icon, which is exactly where a misclick happens. */
const confirming = ref(false)
const currentTitle = computed(() => threads.value.find((t) => t.id === current.value)?.title || current.value)

/** Only the open thread can be deleted — the RPC runs on its own instance — so this needs no
 *  cross-thread case, and cannot race the socket swap that switching one would start. Navigating
 *  away is conditional: a delete that failed leaves a thread that still has something to show. */
async function remove(): Promise<void> {
  confirming.value = false
  if (!(await deleteThread())) {
    return
  }
  await refresh()
  open(threads.value[0]?.id ?? LANDING)
}

const catalogue = ref<ModelRow[]>([])
const deploymentModel = ref('')

const currentModel = computed(() => state.value.modelOverride ?? deploymentModel.value)
const windowOf = (id: string) => catalogue.value.find((m) => m.id === id)?.context
const currentWindow = computed(() => windowOf(currentModel.value))

/**
 * A model is picked, and switching to a smaller window can put an already-fine conversation over
 * the new one. Asked here rather than left to the server, because only the browser holds the
 * catalogue and so only it knows the window of a model the server has never run.
 *
 * Cancelling leaves the model alone: the alternative — switch now, compact at the next message —
 * only moves the same compaction one message later, without asking.
 */
const pendingModel = ref<string | null>(null)

function pickModel(id: string): void {
  if (wouldCompact(contextUsage(state.value).tokens, windowOf(id))) {
    pendingModel.value = id
    return
  }
  void switchModel(id)
}

/** `compact` is what the dialog was answered with. The switch alone would schedule a compaction
 *  only when the conversation is over the *conservative default* window — the new model's own is
 *  not known server-side yet — so a small-window model needs the compaction asked for outright,
 *  or the dialog promises a fold that does not happen until the next message overflows. */
async function switchModel(id: string, compact = false): Promise<void> {
  pendingModel.value = null
  await setModel(id === deploymentModel.value ? null : id)
  if (compact) {
    await compactNow()
  }
}

/** Re-read after the advanced settings change: switching to a custom API swaps the whole catalogue
 *  for that one model, and the picker must not keep showing Workers AI ids under it. */
function loadCatalogue(): void {
  void fetch('/api/models')
    .then((res) => res.json() as Promise<{ current: string; models: ModelRow[] }>)
    .then((payload) => {
      deploymentModel.value = payload.current
      catalogue.value = payload.models
    })
    .catch(() => {})
}
loadCatalogue()

const mode = ref<ChatMode>('chat')

// 欢迎面板的四个快捷指令：三个直接起一个动作，一个打开记忆墙。
const memoryWallOpen = ref(false)

async function welcomeResearch(text: string): Promise<void> {
  mode.value = 'chat'
  await run.propose(text)
  await refresh()
}

async function welcomeMemory(text: string): Promise<void> {
  await say(text)
  await refresh()
}

/**
 * Research mode proposes a plan rather than starting a run — a run costs minutes and hundreds of
 * requests, so it stays behind a confirmation even when the mode says the user meant it. The mode
 * then falls back, because the proposal's own buttons carry the conversation from there.
 *
 * Sending from the landing starts a chat rather than talking to it: `main` is where you are when no
 * thread is open, and a message has to belong to one. `create()` is synchronous, so the call below
 * already goes to the new thread's instance — and it is that call which writes the registry row,
 * which is why the list is re-read after it rather than after a timer long enough to usually be right.
 */
async function onSubmit(message: PromptInputMessage): Promise<void> {
  const text = message.text.trim()
  if (!text) {
    return
  }
  // `/new` 是本地指令：直接开新对话清零上下文，绝不发给模型。
  if (text.toLowerCase() === '/new') {
    await startNewChat()
    return
  }
  // A slash word still names a skill, and a skill is asked for in a turn, not proposed as a run.
  const asResearch = mode.value === 'research' && !text.startsWith('/')
  if (asResearch) {
    mode.value = 'chat'
  }
  // The landing is its own Durable Object, so a model picked there was written to it and not to
  // the thread this message is about to create. Carried over by hand, or the first turn runs on
  // the deployment default and the pick reads as ignored.
  const picked = current.value === LANDING ? state.value.modelOverride : undefined
  if (current.value === LANDING) {
    create()
  }
  if (picked) {
    await setModel(picked)
  }
  await (asResearch ? run.propose(text) : say(text))
  await refresh()
}

/** The split is only a split on a wide screen; below that the report goes under the thread, where
 *  dragging a vertical divider would fight the page's own scrolling. */
const wide = useMediaQuery('(min-width: 1024px)')

// —— 抽屉侧边栏（移动端滑出，含毛玻璃遮罩）——
const narrow = useMediaQuery('(max-width: 767px)')
const drawerOpen = ref(false)

function openFromDrawer(id: string): void {
  open(id)
  if (narrow.value) {
    drawerOpen.value = false
  }
}

function createFromDrawer(): void {
  create()
  if (narrow.value) {
    drawerOpen.value = false
  }
}

/** 零算力清零：不压缩、不调模型，切到一个全新会话（旧对话已在侧边栏历史里）。 */
async function startNewChat(): Promise<void> {
  create()
  if (narrow.value) {
    drawerOpen.value = false
  }
  await refresh()
}

/** 逐条删除：每个会话的 RPC 只在自己的 DO 上执行，所以先切换过去再删。 */
async function clearAllChats(): Promise<void> {
  const ids = threads.value.map((t) => t.id)
  for (const id of ids) {
    open(id)
    await deleteThread()
  }
  await refresh()
  open(LANDING)
  drawerOpen.value = false
}

/** Remembered across reloads: a report is read over several sittings, and re-dragging the divider
 *  every time is the kind of small friction that makes a panel feel disposable. */
const split = useStorage('report-split', 60)

function rememberSplit(sizes: number[]) {
  if (wide.value && showReport.value && sizes.length > 1) {
    split.value = Math.round(sizes[0])
  }
}

const turns = computed(() => groupTurns([...state.value.messages, ...(state.value.live ?? [])], state.value.draft))

function stepState(step: ToolStep): ToolState {
  if (!step.result) {
    return 'input-available'
  }
  return step.result.content.startsWith('error:') ? 'output-error' : 'output-available'
}

function parsedArgs(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments || '{}')
  } catch {
    return call.function.arguments
  }
}

const research = computed(() => state.value.research)
/** A turn being answered, a plan being written, or a run working through its rounds — all of it is
 *  this thread doing something the user did not have to wait in front of. */
const busy = computed(() => !!state.value.status || research.value?.phase === 'running')
const showReport = computed(() => research.value?.phase === 'done' && !!research.value.report)
</script>

<template>
  <!-- Instead of the chat, not over it: with the Worker refusing there is nothing behind this to
       go back to, and a dismissable overlay would leave a dead app underneath. -->
  <div v-if="closed" class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
    <div class="max-w-md space-y-3 text-center">
      <h1 class="text-lg font-medium">{{ t('app.closedTitle') }}</h1>
      <p class="whitespace-pre-line text-left text-sm text-muted-foreground">{{ closed }}</p>
      <Button variant="outline" size="sm" @click="refresh"> {{ t('app.retry') }} </Button>
    </div>
  </div>

  <div v-else class="relative flex h-dvh bg-background text-foreground">
    <!-- 浅色模式的极淡弥散光晕：左上蓝紫、右下暖白，把白卡片从背景里托出来。 -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_40%_at_12%_0%,rgba(139,92,246,0.10),transparent_70%)] bg-no-repeat dark:hidden"
    />
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(40%_35%_at_88%_100%,rgba(56,189,248,0.08),transparent_70%)] bg-no-repeat dark:hidden"
    />

    <Toaster />

    <!-- 抽屉侧边栏：半透明毛玻璃遮罩，点击遮罩关闭 -->
    <div v-if="drawerOpen" class="fixed inset-0 z-40">
      <button
        type="button"
        class="absolute inset-0 bg-background/60 backdrop-blur-sm"
        :aria-label="t('app.close')"
        @click="drawerOpen = false"
      />
      <aside
        class="absolute inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-card/95 shadow-2xl backdrop-blur-md"
      >
        <div class="flex items-center justify-between border-b px-3 py-2.5">
          <span class="flex items-center gap-1.5 font-semibold text-sm">{{ t('app.brand') }}</span>
          <Button variant="ghost" class="size-7 p-0" :aria-label="t('app.close')" @click="drawerOpen = false">
            <XIcon class="size-4" />
          </Button>
        </div>
        <ThreadSidebar
          :threads="threads"
          :busy="busy"
          :current="current"
          class="min-h-0 flex-1"
          @open="openFromDrawer"
          @create="createFromDrawer"
          @remove="confirming = true"
          @rename="rename"
        />
        <div v-if="threads.length" class="border-t p-2">
          <Button variant="ghost" size="sm" class="w-full text-destructive" @click="clearAllChats">
            {{ t('sidebar.clearAllChats') }}
          </Button>
        </div>
      </aside>
    </div>

    <Dialog v-model:open="confirming">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t('app.deleteChatTitle') }}</DialogTitle>
          <DialogDescription>{{ t('app.deleteChatBody', { title: currentTitle }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirming = false"> {{ t('app.cancel') }} </Button>
          <Button variant="destructive" @click="remove"> {{ t('app.delete') }} </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="pendingModel !== null" @update:open="pendingModel = null">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t('app.compactSwitchTitle') }}</DialogTitle>
          <DialogDescription>
            {{
              t('app.compactSwitchBody', {
                tokens: formatTokens(contextUsage(state).tokens),
                model: pendingModel ?? '',
                window: formatTokens(windowOf(pendingModel ?? '') ?? 0),
              })
            }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="pendingModel = null"> {{ t('app.cancel') }} </Button>
          <Button @click="switchModel(pendingModel ?? '', true)"> {{ t('app.compactSwitchConfirm') }} </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b px-4 py-3">
        <Button
          variant="outline"
          class="size-8 rounded-lg p-0 shadow-sm transition-colors hover:bg-accent"
          :aria-label="t('sidebar.drawerAria')"
          @click="drawerOpen = true"
        >
          <MenuIcon class="size-4" />
        </Button>
        <h1 class="font-semibold text-sm">{{ t('app.brand') }}</h1>
        <span
          class="size-2 rounded-full"
          :class="connected ? 'bg-green-500' : 'bg-muted-foreground'"
          :title="connected ? t('app.connected') : t('app.disconnected')"
        />
        <div class="ml-auto flex items-center gap-2">
          <BotHub />
          <MemoryWall v-model:open="memoryWallOpen" />
          <SettingsDialog @advanced-saved="loadCatalogue" />
          <LocaleToggle />
          <ThemePicker />
        </div>
      </header>

      <div class="border-b px-3 py-3 md:px-4">
        <DashboardBar />
      </div>

      <ResizablePanelGroup
        :key="wide && showReport ? 'split' : 'stacked'"
        :direction="wide && showReport ? 'horizontal' : 'vertical'"
        class="min-h-0 flex-1 gap-0 p-4"
        @layout="rememberSplit"
      >
        <ResizablePanel :default-size="wide && showReport ? split : 100" :min-size="25" class="flex min-h-0 flex-col">
          <Conversation class="min-h-0 flex-1">
            <ConversationContent>
              <Collapsible v-if="state.historySummary" class="rounded-md border px-3 py-2 text-xs">
                <CollapsibleTrigger class="flex w-full items-center justify-between gap-2 text-muted-foreground">
                  {{ t('app.earlierConversation') }}
                  <ChevronDownIcon class="size-3.5" />
                </CollapsibleTrigger>
                <CollapsibleContent class="pt-2 text-muted-foreground">
                  {{ state.historySummary }}
                </CollapsibleContent>
              </Collapsible>

              <div v-if="!loaded" class="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader :size="16" />
                {{ t('app.loading') }}
              </div>

              <WelcomePanel
                v-else-if="!turns.length"
                @research="welcomeResearch"
                @memory="welcomeMemory"
                @skills="memoryWallOpen = true"
              />

              <Message v-for="msg in turns" :key="msg.id" :from="msg.from" class="group">
                <MessageContent>
                  <template v-for="(s, i) in msg.segments" :key="i">
                    <MessageResponse v-if="s.kind === 'text'" :content="s.message.content" />
                    <Tool v-else>
                      <ToolHeader type="dynamic-tool" :tool-name="s.call.function.name" :state="stepState(s)" />
                      <ToolContent>
                        <ToolInput :input="parsedArgs(s.call)" />
                        <ToolOutput v-if="s.result" :output="s.result.content" :error-text="undefined" />
                      </ToolContent>
                    </Tool>
                  </template>
                  <!-- What the answer cost, where the answer is — the meter above it prices the
                     next request instead, and the two are different questions. Absent rather than
                     zero when the provider reported no usage: see `stage: 'unmetered'`. -->
                  <span
                    v-if="msg.final?.tokens"
                    class="text-muted-foreground text-xs tabular-nums"
                    :title="t('app.tokensTitle', { n: msg.final.tokens.toLocaleString() })"
                  >
                    {{ t('app.tokenCount', { n: formatTokens(msg.final.tokens) }) }}
                  </span>
                  <!-- Only on answers that can be pointed at: a rating is evidence for the nightly
                     pass, and one that names no message is not evidence at all. -->
                  <MessageFeedback
                    v-if="msg.from === 'assistant' && msg.final"
                    :message-id="msg.final.id"
                    :rate="rateMessage"
                  />
                </MessageContent>
              </Message>

              <div v-if="state.status" class="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader :size="16" />
                {{ state.status === 'compacting' ? t('app.compacting') : t('app.thinking') }}
              </div>

              <ResearchProposal
                v-if="research?.phase === 'proposed'"
                :research="research"
                @start="run.start"
                @stop="run.stop"
                @revise="run.revise"
              />
              <ResearchRunning v-else-if="research?.phase === 'running'" :research="research" @stop="run.stop" />
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <!-- No PromptInputBody: it wraps its children in a `display:contents` div, and InputGroup
             switches to a column with `has-[>[data-align=block-end]]`, a direct-child selector the
             wrapper defeats — the textarea ends up one character wide. -->
          <PromptInput class="mt-3" @submit="onSubmit">
            <PromptInputTextarea :placeholder="mode === 'research' ? t('composer.researchPlaceholder') : t('composer.placeholder')" />
            <PromptInputFooter>
              <PromptInputTools class="ml-auto min-w-0">
                <ContextMeter :state="state" :window="currentWindow" @compact="compactNow" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-7 shrink-0 px-2 text-[11px]"
                  :title="t('composer.newChatTitle')"
                  @click="startNewChat"
                >
                  <PlusIcon class="size-3.5" />
                  {{ t('composer.newChat') }}
                </Button>
                <ModePicker v-model="mode" />
                <ModelPicker
                  :catalogue="catalogue"
                  :deployment-model="deploymentModel"
                  :override="state.modelOverride"
                  compact
                  @select="pickModel"
                />
              </PromptInputTools>
              <PromptInputSubmit class="shrink-0" :status="state.status === 'thinking' ? 'submitted' : undefined" />
            </PromptInputFooter>
          </PromptInput>
        </ResizablePanel>

        <template v-if="showReport && research">
          <ResizableHandle
            with-handle
            class="mx-3 my-0 data-[orientation=vertical]:mx-0 data-[orientation=vertical]:my-3"
          />
          <!-- Collapsible rather than closable: dismissing the report and ending the run were one
               gesture, so "I do not want this on screen" destroyed it. Dragging past `min-size`
               folds it to a rail, and the rail is what opens it again — no button anywhere else,
               and nothing that can disagree with the state. -->
          <ResizablePanel
            v-slot="{ isCollapsed, collapse, expand }"
            :default-size="100 - split"
            :min-size="20"
            collapsible
            :collapsed-size="3"
            class="flex min-h-0"
          >
            <button
              v-if="isCollapsed"
              class="flex h-full w-full items-center justify-center text-muted-foreground hover:text-foreground"
              :title="t('app.openReport', { topic: research.topic })"
              @click="expand()"
            >
              <!-- Sideways only where the rail is a column. Below `lg` the group stacks, so the
                   collapsed panel is a thin horizontal band and vertical text would not fit it. -->
              <span class="text-xs lg:[writing-mode:vertical-rl] lg:rotate-180">{{ t('app.reportRail') }}</span>
            </button>
            <ResearchReport
              v-else
              :research="research"
              class="min-h-0 flex-1"
              @save="run.save"
              @stop="run.stop"
              @collapse="collapse()"
            />
          </ResizablePanel>
        </template>
      </ResizablePanelGroup>
    </div>
  </div>
</template>
