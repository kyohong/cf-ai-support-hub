<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugIcon,
  SendIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useMcpServers } from '@/useMcpServers'
import { toast } from '@/useToasts'
import { landingRpc } from '@/useDashboard'
import { locale, setLocale, t } from '@/i18n'
import type { McpServer } from '@/types/mcp'
import type { AdvancedSettingsInput, AdvancedSettingsView, ApiTestResult, DashboardData } from '@/types'

const emit = defineEmits<{ advancedSaved: [] }>()

const open = ref(false)
const { servers, busy, error, refresh, add, replace, connect, remove } = useMcpServers(open)

const name = ref('')
const url = ref('')
const bearer = ref('')
const editing = ref<string | null>(null)

// —— 推送渠道 + 早报（配置存进 vault，env secrets 优先；输入留空表示保持原值） ——
const feishu = ref('')
const tgToken = ref('')
const tgChat = ref('')
const masks = ref<{ feishu?: string; telegram?: string }>({})
const briefingTime = ref('08:00')
const briefingKeywords = ref('')
const savingNotify = ref(false)
const savingBriefing = ref(false)
const testingBriefing = ref(false)

watch(open, (v) => {
  if (v) {
    void loadSettings()
    void loadAdvanced()
  }
})

// —— 高级设置：SOUL 人格 + 自定义第三方模型 ——
const advancedOpen = ref(false)
const soul = ref('')
const customEnabled = ref(false)
const customBaseUrl = ref('')
const customApiKey = ref('')
const customModel = ref('')
const tavilyKey = ref('')
const braveKey = ref('')
const keyMasked = ref<string>()
const tavilyMasked = ref<string>()
const braveMasked = ref<string>()
const showKey = ref(false)
const savingAdvanced = ref(false)
const testingApi = ref(false)

const keyPlaceholder = computed(() =>
  keyMasked.value
    ? t('settings.apiKeyConfigured', { mask: keyMasked.value })
    : t('settings.apiKeyPlaceholder'),
)

async function loadAdvanced(): Promise<void> {
  try {
    const v = await landingRpc<AdvancedSettingsView>('getAdvancedSettings')
    soul.value = v.soulPrompt
    customEnabled.value = v.customApiEnabled
    customBaseUrl.value = v.customBaseUrl
    customModel.value = v.customModel
    keyMasked.value = v.customApiKeyMasked
    tavilyMasked.value = v.tavilyApiKeyMasked
    braveMasked.value = v.braveApiKeyMasked
    customApiKey.value = ''
    tavilyKey.value = ''
    braveKey.value = ''
  } catch {}
}

function advancedDraft(): AdvancedSettingsInput {
  return {
    soulPrompt: soul.value,
    customApiEnabled: customEnabled.value,
    customBaseUrl: customBaseUrl.value,
    customApiKey: customApiKey.value,
    customModel: customModel.value,
    tavilyApiKey: tavilyKey.value,
    braveApiKey: braveKey.value,
  }
}

async function saveAdvanced(): Promise<void> {
  savingAdvanced.value = true
  try {
    const saved = await landingRpc<AdvancedSettingsView>('saveAdvancedSettings', [advancedDraft()])
    soul.value = saved.soulPrompt
    customEnabled.value = saved.customApiEnabled
    customBaseUrl.value = saved.customBaseUrl
    customModel.value = saved.customModel
    keyMasked.value = saved.customApiKeyMasked
    tavilyMasked.value = saved.tavilyApiKeyMasked
    braveMasked.value = saved.braveApiKeyMasked
    customApiKey.value = ''
    tavilyKey.value = ''
    braveKey.value = ''
    toast(t('settings.advancedSaved'))
    emit('advancedSaved')
  } catch (err) {
    toast(t('settings.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    savingAdvanced.value = false
  }
}

async function testConnection(): Promise<void> {
  testingApi.value = true
  try {
    const result = await landingRpc<ApiTestResult>('testCustomApiConnection', [advancedDraft()])
    toast(result.detail)
  } catch (err) {
    toast(t('settings.testFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    testingApi.value = false
  }
}

async function loadSettings(): Promise<void> {
  try {
    const d = await landingRpc<DashboardData>('getDashboard')
    masks.value = d.notify ?? {}
    if (d.briefingTime) {
      briefingTime.value = d.briefingTime
    }
    briefingKeywords.value = d.briefingKeywords || ''
  } catch {}
}

async function saveNotify(): Promise<void> {
  savingNotify.value = true
  try {
    await landingRpc('saveNotifySettings', [
      { feishu: feishu.value, telegramToken: tgToken.value, telegramChat: tgChat.value },
    ])
    feishu.value = ''
    tgToken.value = ''
    tgChat.value = ''
    await loadSettings()
    toast(t('settings.channelsSaved'))
  } catch (err) {
    toast(t('settings.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    savingNotify.value = false
  }
}

async function saveBriefing(): Promise<void> {
  savingBriefing.value = true
  try {
    await landingRpc('configureBriefing', [briefingTime.value, briefingKeywords.value])
    toast(t('settings.briefingScheduled', { time: briefingTime.value }))
  } catch (err) {
    toast(t('settings.briefingScheduleFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    savingBriefing.value = false
  }
}

async function testBriefing(): Promise<void> {
  testingBriefing.value = true
  try {
    await landingRpc('runBriefingNow')
    toast(t('welcome.briefingStarted'))
  } catch (err) {
    toast(t('welcome.briefingFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    testingBriefing.value = false
  }
}

function load(server?: McpServer): void {
  editing.value = server?.id ?? null
  name.value = server?.name ?? ''
  url.value = server?.url ?? ''
  bearer.value = ''
}

async function submit(): Promise<void> {
  if (!name.value.trim() || !url.value.trim()) {
    return
  }
  const server = editing.value
    ? await replace(editing.value, name.value, url.value, bearer.value)
    : await add(name.value, url.value, bearer.value)
  if (server) {
    load()
  }
}

function stateLabel(server: McpServer): string {
  switch (server.state) {
    case 'ready':
      return t('settings.mcpReady')
    case 'authenticating':
      return t('settings.mcpWaiting')
    case 'failed':
      return t('settings.mcpFailed')
    default:
      return t('settings.mcpUnknown')
  }
}

const stateClass = (server: McpServer) =>
  server.state === 'ready'
    ? 'text-green-600 dark:text-green-500'
    : server.state === 'failed'
      ? 'text-destructive'
      : server.state === 'authenticating'
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-muted-foreground'

const sorted = computed(() => [...servers.value].sort((a, b) => a.name.localeCompare(b.name)))
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="ghost" class="size-7 p-0" :aria-label="t('settings.triggerAria')">
        <SettingsIcon class="size-4" />
      </Button>
    </DialogTrigger>
    <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('settings.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('settings.desc') }}
        </DialogDescription>
      </DialogHeader>

      <!-- 界面语言：与顶栏的胶囊按钮同步，切完立即重渲染 -->
      <div class="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/50 px-3 py-2">
        <span class="flex items-center gap-1.5 font-medium text-sm">
          <LanguagesIcon class="size-4" />
          {{ t('settings.language') }}
        </span>
        <div class="flex gap-1">
          <Button
            type="button"
            size="sm"
            class="h-7 px-2 text-xs"
            :variant="locale === 'zh' ? 'default' : 'outline'"
            @click="setLocale('zh')"
          >
            {{ t('locale.zh') }}
          </Button>
          <Button
            type="button"
            size="sm"
            class="h-7 px-2 text-xs"
            :variant="locale === 'en' ? 'default' : 'outline'"
            @click="setLocale('en')"
          >
            {{ t('locale.en') }}
          </Button>
        </div>
      </div>

      <!-- 早报：时间 + 关键词 + 立即测试 -->
      <section class="grid gap-2 rounded-xl border border-border/70 bg-card/50 p-3">
        <h3 class="font-medium text-sm">{{ t('settings.briefing') }}</h3>
        <div class="flex gap-2">
          <Input
            v-model="briefingTime"
            type="time"
            class="w-28"
            :aria-label="t('settings.briefingTime')"
            autocomplete="off"
          />
          <Input
            v-model="briefingKeywords"
            :placeholder="t('settings.keywordsPlaceholder')"
            :aria-label="t('settings.keywordsAria')"
            autocomplete="off"
          />
        </div>
        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="testingBriefing" @click="testBriefing">
            <LoaderCircleIcon v-if="testingBriefing" class="size-3.5 animate-spin" />
            <SendIcon v-else class="size-3.5" />
            {{ t('settings.runBriefing') }}
          </Button>
          <Button type="button" size="sm" :disabled="savingBriefing" @click="saveBriefing">
            <LoaderCircleIcon v-if="savingBriefing" class="size-3.5 animate-spin" />
            {{ t('settings.saveSchedule') }}
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">
          {{ t('settings.briefingHint') }}
        </p>
      </section>

      <!-- 推送渠道 -->
      <section class="grid gap-2 rounded-xl border border-border/70 bg-card/50 p-3">
        <h3 class="font-medium text-sm">{{ t('settings.channels') }}</h3>
        <Input
          v-model="feishu"
          :placeholder="
            masks.feishu
              ? t('settings.feishuConfigured', { mask: masks.feishu })
              : t('settings.feishuPlaceholder')
          "
          :aria-label="t('settings.feishuAria')"
          autocomplete="off"
        />
        <Input
          v-model="tgToken"
          :placeholder="
            masks.telegram
              ? t('settings.telegramTokenConfigured', { mask: masks.telegram })
              : t('settings.telegramTokenPlaceholder')
          "
          :aria-label="t('settings.telegramTokenAria')"
          autocomplete="off"
        />
        <Input v-model="tgChat" :placeholder="t('settings.telegramChatPlaceholder')" :aria-label="t('settings.telegramChatAria')" autocomplete="off" />
        <div class="flex justify-end">
          <Button type="button" size="sm" :disabled="savingNotify" @click="saveNotify">
            <LoaderCircleIcon v-if="savingNotify" class="size-3.5 animate-spin" />
            {{ t('settings.saveChannels') }}
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">
          {{ t('settings.channelsHint') }}
        </p>
      </section>

      <!-- 高级设置：默认折叠，避免喧宾夺主 -->
      <Collapsible v-model:open="advancedOpen" class="rounded-xl border border-border/70 bg-card/50">
        <CollapsibleTrigger
          class="flex w-full items-center justify-between gap-2 px-3 py-2.5 font-medium text-sm"
        >
          <span class="flex items-center gap-1.5">
            <SlidersHorizontalIcon class="size-4" />
            {{ t('settings.advanced') }}
            <span class="text-muted-foreground font-normal text-xs">{{ t('settings.advancedHint') }}</span>
          </span>
          <ChevronDownIcon
            class="size-4 text-muted-foreground transition-transform"
            :class="advancedOpen ? 'rotate-180' : ''"
          />
        </CollapsibleTrigger>
        <CollapsibleContent class="grid gap-3 px-3 pb-3">
          <!-- 卡片 A：AI 核心人格 -->
          <div class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-medium text-sm">{{ t('settings.soul') }}</h4>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-xs"
                @click="soul = ''"
              >
                {{ t('settings.soulReset') }}
              </Button>
            </div>
            <Textarea
              v-model="soul"
              rows="7"
              :placeholder="t('settings.soulPlaceholder')"
              :aria-label="t('settings.soulAria')"
            />
          </div>

          <!-- 卡片 B：自定义第三方模型 -->
          <div class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-medium text-sm">{{ t('settings.customApi') }}</h4>
              <button
                type="button"
                role="switch"
                :aria-checked="customEnabled"
                :aria-label="t('settings.enableCustom')"
                class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                :class="customEnabled ? 'bg-emerald-500' : 'bg-muted'"
                @click="customEnabled = !customEnabled"
              >
                <span
                  class="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all"
                  :class="customEnabled ? 'left-[18px]' : 'left-0.5'"
                />
              </button>
            </div>
            <p v-if="!customEnabled" class="text-muted-foreground text-xs">
              {{ t('settings.customOff') }}
            </p>
            <template v-else>
              <Input
                v-model="customBaseUrl"
                :placeholder="t('settings.baseUrlPlaceholder')"
                :aria-label="t('settings.baseUrlAria')"
                autocomplete="off"
              />
              <div class="relative">
                <Input
                  v-model="customApiKey"
                  :type="showKey ? 'text' : 'password'"
                  :placeholder="keyPlaceholder"
                  class="pr-9"
                  :aria-label="t('settings.apiKeyAria')"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  :aria-label="showKey ? t('settings.hideKey') : t('settings.showKey')"
                  @click="showKey = !showKey"
                >
                  <EyeOffIcon v-if="showKey" class="size-4" />
                  <EyeIcon v-else class="size-4" />
                </button>
              </div>
              <Input
                v-model="customModel"
                :placeholder="t('settings.modelPlaceholder')"
                :aria-label="t('settings.modelIdAria')"
                autocomplete="off"
              />
              <div class="flex justify-end">
                <Button type="button" variant="outline" size="sm" :disabled="testingApi" @click="testConnection">
                  <LoaderCircleIcon v-if="testingApi" class="size-3.5 animate-spin" />
                  {{ t('settings.test') }}
                </Button>
              </div>
            </template>
          </div>

          <!-- 卡片 C：搜索增强 Key（可选） -->
          <div class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
            <h4 class="font-medium text-sm">{{ t('settings.searchKeys') }}</h4>
            <p class="text-muted-foreground text-xs">{{ t('settings.searchKeysHint') }}</p>
            <Input
              v-model="tavilyKey"
              :placeholder="
                tavilyMasked
                  ? t('settings.tavilyConfigured', { mask: tavilyMasked })
                  : t('settings.tavilyPlaceholder')
              "
              :aria-label="t('settings.tavilyPlaceholder')"
              autocomplete="off"
            />
            <Input
              v-model="braveKey"
              :placeholder="
                braveMasked
                  ? t('settings.braveConfigured', { mask: braveMasked })
                  : t('settings.bravePlaceholder')
              "
              :aria-label="t('settings.bravePlaceholder')"
              autocomplete="off"
            />
          </div>

          <div class="flex justify-end">
            <Button type="button" size="sm" :disabled="savingAdvanced" @click="saveAdvanced">
              <LoaderCircleIcon v-if="savingAdvanced" class="size-3.5 animate-spin" />
              {{ t('settings.saveAdvanced') }}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div class="grid gap-4">
        <form class="grid gap-2" @submit.prevent="submit">
          <Input v-model="name" :placeholder="t('settings.mcpNamePlaceholder')" :aria-label="t('settings.mcpNameAria')" autocomplete="off" />
          <Input
            v-model="url"
            :placeholder="t('settings.mcpUrlPlaceholder')"
            :aria-label="t('settings.mcpUrlAria')"
            autocomplete="off"
          />
          <Input
            v-model="bearer"
            type="password"
            :placeholder="editing ? t('settings.mcpBearerEditPlaceholder') : t('settings.mcpBearerPlaceholder')"
            :aria-label="t('settings.mcpBearerAria')"
            autocomplete="off"
          />
          <div class="flex items-center justify-end gap-2">
            <p v-if="error" class="text-muted-foreground mr-auto text-xs">{{ error }}</p>
            <Button v-if="editing" type="button" variant="ghost" size="sm" :disabled="busy" @click="load()">
              {{ t('app.cancel') }}
            </Button>
            <Button type="submit" size="sm" :disabled="busy || !name.trim() || !url.trim()">
              <LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" />
              {{ editing ? t('settings.mcpSave') : t('settings.mcpAdd') }}
            </Button>
          </div>
        </form>

        <div class="max-h-72 space-y-2 overflow-y-auto pr-1">
          <p v-if="!sorted.length" class="text-muted-foreground px-1 text-sm">
            {{ t('settings.mcpEmpty') }}
          </p>
          <div v-for="server in sorted" :key="server.id" class="flex items-center gap-2 rounded-md border px-3 py-2">
            <PlugIcon class="text-muted-foreground size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="flex items-baseline gap-2 text-sm">
                <span class="font-medium">{{ server.name }}</span>
                <span class="text-muted-foreground truncate text-xs">{{ server.url }}</span>
              </p>
              <p class="text-xs" :class="stateClass(server)">
                {{ stateLabel(server) }}
                <span v-if="server.state === 'failed' && server.error" class="text-muted-foreground">
                  ({{ server.error }})
                </span>
              </p>
            </div>
            <Button
              v-if="server.state === 'authenticating'"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="connect(server.id)"
            >
              {{ t('settings.mcpSignIn') }}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('settings.mcpEdit', { name: server.name })"
              :disabled="busy"
              @click="load(server)"
            >
              <PencilIcon class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('settings.mcpRemove', { name: server.name })"
              :disabled="busy"
              @click="remove(server.id)"
            >
              <Trash2Icon class="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" class="mr-auto" @click="refresh"> {{ t('settings.mcpRefresh') }} </Button>
        <Button variant="outline" size="sm" @click="open = false"> {{ t('app.done') }} </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
