<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BotIcon, LoaderCircleIcon, PlusIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { toast } from '@/useToasts'
import { useBots, type Bot } from '@/useBots'
import { t } from '@/i18n'
import BotBasics from '@/components/bothub/BotBasics.vue'
import BotKnowledge from '@/components/bothub/BotKnowledge.vue'
import BotConversations from '@/components/bothub/BotConversations.vue'
import BotLeads from '@/components/bothub/BotLeads.vue'
import BotMemory from '@/components/bothub/BotMemory.vue'

type Tab = 'basics' | 'memory' | 'knowledge' | 'conversations' | 'leads'

const open = ref(false)
const tab = ref<Tab>('basics')
const selected = ref<string | null>(null)
const creating = ref(false)
const newName = ref('')
const busy = ref(false)
const prefill = ref('')

const { bots, loading, refresh, create } = useBots()
const current = computed<Bot | null>(() => bots.value.find((b) => b.id === selected.value) ?? bots.value[0] ?? null)
/** `<select>` 不能绑 null：空列表时用空串占位，切换时写回。 */
const selectedModel = computed({
  get: () => selected.value ?? '',
  set: (v: string) => (selected.value = v || null),
})

const tabs = computed<Array<{ id: Tab; label: string }>>(() => [
  { id: 'basics', label: t('bothub.tabBasics') },
  { id: 'memory', label: t('bothub.tabMemory') },
  { id: 'knowledge', label: t('bothub.tabKnowledge') },
  { id: 'conversations', label: t('bothub.tabConversations') },
  { id: 'leads', label: t('bothub.tabLeads') },
])

watch(open, async (v) => {
  if (!v) {
    return
  }
  busy.value = true
  try {
    await refresh()
    selected.value = bots.value[0]?.id ?? null
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
})

async function addBot(): Promise<void> {
  const name = newName.value.trim()
  if (!name) {
    return
  }
  busy.value = true
  try {
    const bot = await create(name)
    newName.value = ''
    creating.value = false
    selected.value = bot.id
    tab.value = 'basics'
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}

async function onSaved(): Promise<void> {
  await refresh()
}

async function onDeleted(): Promise<void> {
  selected.value = null
  await refresh()
  selected.value = bots.value[0]?.id ?? null
}

function teach(question: string): void {
  prefill.value = question
  tab.value = 'knowledge'
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="ghost" class="size-7 p-0" :aria-label="t('bothub.triggerAria')">
        <BotIcon class="size-4" />
      </Button>
    </DialogTrigger>
    <DialogContent class="flex h-[90dvh] w-[96vw] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl md:h-[84vh] md:w-[92vw]">
      <DialogHeader class="shrink-0 border-b px-4 py-3">
        <DialogTitle class="flex items-center gap-2">
          <BotIcon class="size-4" />
          {{ t('bothub.title') }}
        </DialogTitle>
        <DialogDescription>{{ t('bothub.desc') }}</DialogDescription>
      </DialogHeader>

      <!-- 手机端：侧边栏收起为顶部切换条，桌面端保留双栏 -->
      <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2 md:hidden">
        <select
          :value="selectedModel"
          class="h-9 min-w-0 flex-1 rounded-lg border border-border/70 bg-card/70 px-2 text-sm backdrop-blur-md"
          :aria-label="t('bothub.triggerAria')"
          @change="selectedModel = ($event.target as HTMLSelectElement).value"
        >
          <option v-if="!bots.length" value="">{{ t('bothub.empty') }}</option>
          <option v-for="bot in bots" :key="bot.id" :value="bot.id">
            {{ bot.name }} · {{ bot.enabled ? t('bothub.online') : t('bothub.disabled') }} ·
            {{ t('bothub.todayMessages', { n: bot.todayMessages ?? 0 }) }}
          </option>
        </select>
        <template v-if="creating">
          <Input
            v-model="newName"
            class="min-w-0 flex-1"
            :placeholder="t('bothub.newBotPlaceholder')"
            autofocus
            @keydown.enter.prevent="addBot"
          />
          <Button variant="ghost" size="sm" class="h-9 shrink-0" @click="creating = false">{{ t('app.cancel') }}</Button>
          <Button size="sm" class="shrink-0" :disabled="busy || !newName.trim()" @click="addBot">
            {{ t('bothub.create') }}
          </Button>
        </template>
        <Button v-else variant="outline" size="sm" class="h-9 shrink-0 whitespace-nowrap" @click="creating = true">
          <PlusIcon class="size-3.5" />
          {{ t('bothub.newBot') }}
        </Button>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- 子客服列表 -->
        <aside class="hidden shrink-0 border-r md:flex md:w-64 md:flex-col lg:w-72">
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <p v-if="loading && !bots.length" class="text-muted-foreground px-1 py-2 text-xs">
              {{ t('app.loading') }}
            </p>
            <p v-else-if="!bots.length" class="text-muted-foreground px-1 py-2 text-xs">
              {{ t('bothub.empty') }}
            </p>
            <ul class="grid gap-1">
              <li v-for="bot in bots" :key="bot.id">
                <button
                  type="button"
                  class="w-full rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
                  :class="bot.id === current?.id && 'bg-accent font-medium'"
                  @click="selected = bot.id"
                >
                  <span class="flex items-center gap-1.5">
                    <span
                      class="size-2 shrink-0 rounded-full"
                      :class="bot.enabled ? 'bg-emerald-500' : 'bg-muted-foreground'"
                    />
                    <span class="truncate">{{ bot.name }}</span>
                  </span>
                  <span class="text-muted-foreground mt-0.5 block truncate text-xs">
                    {{ t('bothub.todayMessages', { n: bot.todayMessages ?? 0 }) }}
                  </span>
                </button>
              </li>
            </ul>
          </div>
          <div class="shrink-0 border-t p-2">
            <div v-if="creating" class="grid gap-1.5">
              <Input
                v-model="newName"
                :placeholder="t('bothub.newBotPlaceholder')"
                autofocus
                @keydown.enter.prevent="addBot"
              />
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="sm" @click="creating = false">{{ t('app.cancel') }}</Button>
                <Button size="sm" :disabled="busy || !newName.trim()" @click="addBot">
                  <LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" />
                  {{ t('bothub.create') }}
                </Button>
              </div>
            </div>
            <Button v-else variant="outline" class="w-full justify-start gap-2" @click="creating = true">
              <PlusIcon class="size-3.5" />
              {{ t('bothub.newBot') }}
            </Button>
          </div>
        </aside>

        <!-- 右侧标签页 -->
        <section v-if="current" class="flex min-w-0 flex-1 flex-col">
          <div class="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Button
              v-for="item in tabs"
              :key="item.id"
              size="sm"
              class="h-7 shrink-0 px-2.5 text-xs"
              :variant="tab === item.id ? 'default' : 'ghost'"
              @click="tab = item.id"
            >
              {{ item.label }}
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <BotBasics v-if="tab === 'basics'" :bot="current" @saved="onSaved" @deleted="onDeleted" />
            <BotMemory v-else-if="tab === 'memory'" :bot-id="current.id" />
            <BotKnowledge v-else-if="tab === 'knowledge'" :bot-id="current.id" :prefill="prefill" />
            <BotConversations
              v-else-if="tab === 'conversations'"
              :bot-id="current.id"
              @teach="teach"
            />
            <BotLeads v-else :bot-id="current.id" />
          </div>
        </section>
        <section v-else class="flex flex-1 items-center justify-center p-6">
          <p class="text-muted-foreground max-w-xs text-center text-sm">{{ t('bothub.emptyHint') }}</p>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
