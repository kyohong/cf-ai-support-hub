<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { useMediaQuery, useStorage } from '@vueuse/core'
import { ActivityIcon, ChevronDownIcon, ChevronUpIcon, DatabaseIcon, NewspaperIcon, ZapIcon } from '@lucide/vue'
import { landingRpc } from '@/useDashboard'
import { t } from '@/i18n'
import type { DashboardData } from '@/types'

const data = ref<DashboardData | null>(null)
const colo = ref('')
const now = ref(Date.now())

// 状态卡折叠：用户手动选择存在 localStorage；从未选择时手机端默认折叠，把屏幕留给聊天。
const narrow = useMediaQuery('(max-width: 767px)')
const stored = useStorage<'open' | 'closed'>('dash-collapsed', narrow.value ? 'closed' : 'open')
const collapsed = computed({
  get: () => stored.value === 'closed',
  set: (v: boolean) => (stored.value = v ? 'closed' : 'open'),
})

async function load(): Promise<void> {
  try {
    data.value = await landingRpc<DashboardData>('getDashboard')
    now.value = Date.now()
  } catch {
    // 看板是锦上添花：拿不到就保持上一份数据，下一轮再试。
  }
}

async function loadColo(): Promise<void> {
  try {
    const res = await fetch('/api/threads')
    colo.value = res.headers.get('cf-ray')?.split('-')[1]?.toUpperCase() ?? ''
  } catch {}
}

onMounted(() => {
  void load()
  void loadColo()
})
const timer = setInterval(load, 60_000)
onScopeDispose(() => clearInterval(timer))

const pct = computed(() => {
  const u = data.value?.usage
  if (!u || !u.requestsLimit || !u.neuronsLimit) {
    return 0
  }
  return Math.min(100, Math.round(Math.max(u.requests / u.requestsLimit, u.neurons / u.neuronsLimit) * 100))
})
const left = computed(() => 100 - pct.value)
const countdown = computed(() => {
  const at = data.value?.nextBriefingAt
  if (!at) {
    return t('dash.countdownNone')
  }
  const ms = at - now.value
  if (ms <= 0) {
    return t('dash.countdownSoon')
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  return h >= 1 ? t('dash.countdownH', { h, m }) : t('dash.countdownM', { m })
})
</script>

<template>
  <!-- 折叠态：一行轻巧胶囊状态条 -->
  <button
    v-if="collapsed"
    type="button"
    class="flex w-full items-center gap-2 rounded-full border border-border/70 bg-card/70 px-3 py-2 text-left text-xs shadow-sm backdrop-blur-md transition-shadow hover:shadow-md"
    :title="t('dash.expand')"
    @click="collapsed = false"
  >
    <span class="relative flex size-2 shrink-0">
      <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
      <span class="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
    <span class="min-w-0 truncate">
      {{ t('dash.online') }} · {{ t('dash.free') }} · {{ t('dash.pillUsage', { pct }) }}
    </span>
    <ChevronDownIcon class="text-muted-foreground ml-auto size-3.5 shrink-0" />
  </button>

  <!-- 展开态：Bento 看板（窄屏 2×2，宽屏一行四张）+ 右上角收起按钮 -->
  <div v-else class="relative">
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground absolute top-0 right-0 z-10 flex items-center gap-1 rounded-full border border-border/70 bg-card/80 px-2.5 py-1 text-[11px] backdrop-blur"
      :title="t('dash.collapse')"
      @click="collapsed = true"
    >
      <ChevronUpIcon class="size-3" />
      {{ t('dash.collapse') }}
    </button>
    <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
    <div
      class="rounded-2xl border border-black/[0.06] bg-white/80 p-3.5 shadow-sm shadow-black/[0.04] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.08] dark:border-white/10 dark:bg-card/70 dark:shadow-none md:p-4"
    >
      <p class="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ActivityIcon class="size-3.5" /> {{ t('dash.status') }}
      </p>
      <p class="mt-2 flex items-center gap-2">
        <span class="relative flex size-2.5">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span class="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
        </span>
        <span class="font-semibold text-sm">{{ t('dash.online') }}</span>
      </p>
      <p class="mt-1 truncate text-muted-foreground text-xs">{{ colo ? t('dash.colo', { colo }) : t('dash.globalEdge') }}</p>
    </div>

    <div
      class="rounded-2xl border border-black/[0.06] bg-white/80 p-3.5 shadow-sm shadow-black/[0.04] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.08] dark:border-white/10 dark:bg-card/70 dark:shadow-none md:p-4"
    >
      <p class="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ZapIcon class="size-3.5" /> {{ t('dash.cost') }}
      </p>
      <p class="mt-2 font-bold text-2xl tabular-nums tracking-tight text-emerald-500">{{ t('dash.free') }}</p>
      <p class="mt-1 truncate text-muted-foreground text-xs">{{ t('dash.freeSub') }}</p>
    </div>

    <div
      class="rounded-2xl border border-black/[0.06] bg-white/80 p-3.5 shadow-sm shadow-black/[0.04] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.08] dark:border-white/10 dark:bg-card/70 dark:shadow-none md:p-4"
    >
      <p class="flex items-center gap-1.5 text-muted-foreground text-xs">
        <DatabaseIcon class="size-3.5" /> {{ t('dash.quota') }}
      </p>
      <p class="mt-2 font-semibold text-sm tabular-nums">{{ t('dash.usage', { pct, left }) }}</p>
      <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-500"
          :style="{ width: `${pct}%` }"
        />
      </div>
      <p class="mt-1.5 truncate text-muted-foreground text-xs tabular-nums">
        {{ t('dash.usageDetail', { req: data?.usage.requests ?? 0, neu: data?.usage.neurons ?? 0 }) }}
      </p>
    </div>

    <div
      class="rounded-2xl border border-black/[0.06] bg-white/80 p-3.5 shadow-sm shadow-black/[0.04] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.08] dark:border-white/10 dark:bg-card/70 dark:shadow-none md:p-4"
    >
      <p class="flex items-center gap-1.5 text-muted-foreground text-xs">
        <NewspaperIcon class="size-3.5" /> {{ t('dash.kb') }}
      </p>
      <p class="mt-2 font-semibold text-sm tabular-nums">
        {{ t('dash.kbCounts', { m: data?.memoryCount ?? 0, s: data?.skillCount ?? 0 }) }}
      </p>
      <p class="mt-1 truncate text-muted-foreground text-xs">
        {{ t('dash.nextBriefing', { time: data?.briefingTime ?? '', countdown }) }}
      </p>
    </div>
    </div>
  </div>
</template>
