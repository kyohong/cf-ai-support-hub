<script setup lang="ts">
import { computed, ref } from 'vue'
import { TelescopeIcon } from '@lucide/vue'
import { toast } from '@/useToasts'
import { landingRpc } from '@/useDashboard'
import { t } from '@/i18n'

const emit = defineEmits<{ research: [text: string]; memory: [text: string]; skills: [] }>()
const briefingBusy = ref(false)

async function briefing(): Promise<void> {
  briefingBusy.value = true
  try {
    await landingRpc('runBriefingNow')
    toast(t('welcome.briefingStarted'))
  } catch (err) {
    toast(t('welcome.briefingFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    briefingBusy.value = false
  }
}

const cards = computed(() =>
  [
    { emoji: '🔍', title: t('welcome.research'), hint: t('welcome.researchHint'), action: 'research' },
    { emoji: '📰', title: t('welcome.briefing'), hint: t('welcome.briefingHint'), action: 'briefing' },
    { emoji: '🧠', title: t('welcome.memory'), hint: t('welcome.memoryHint'), action: 'memory' },
    { emoji: '🛠️', title: t('welcome.skills'), hint: t('welcome.skillsHint'), action: 'skills' },
  ] as const,
)
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-2 py-10">
    <p class="text-center font-semibold text-lg">{{ t('welcome.slogan') }}</p>
    <p class="text-muted-foreground mt-1.5 text-center text-sm">{{ t('welcome.subtitle') }}</p>

    <div class="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <button
        v-for="c in cards"
        :key="c.title"
        type="button"
        class="group rounded-2xl border border-black/[0.06] bg-white/80 p-4 text-left shadow-sm shadow-black/[0.04] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.08] disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-card/70 dark:shadow-none"
        :disabled="c.action === 'briefing' && briefingBusy"
        @click="
          c.action === 'research'
            ? emit('research', t('welcome.researchPrompt'))
            : c.action === 'memory'
              ? emit('memory', t('welcome.memoryPrompt'))
              : c.action === 'briefing'
                ? briefing()
                : emit('skills')
        "
      >
        <p class="text-base">{{ c.emoji }}</p>
        <p class="mt-1.5 font-medium text-sm">{{ c.title }}</p>
        <p class="text-muted-foreground mt-1 text-xs">{{ c.hint }}</p>
      </button>
    </div>

    <p class="text-muted-foreground mt-6 flex items-center justify-center gap-1.5 text-xs">
      <TelescopeIcon class="size-3.5" />
      {{ t('welcome.footer') }}
    </p>
  </div>
</template>
