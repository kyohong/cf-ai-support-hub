<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '@vueuse/core'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader } from '@/components/ai-elements/loader'
import { Button } from '@/components/ui/button'
import { formatTokens } from '@/lib/context'
import { pageCounts, pageLabel } from '@/lib/research'
import { t } from '@/i18n'
import type { ResearchState } from '@/types'

const props = defineProps<{ research: ResearchState }>()
const emit = defineEmits<{ (e: 'stop'): void }>()

// A run is bounded by a clock (two, five or ten minutes by preset), so the elapsed time is the
// number that says how much of the run is left — it has to move on its own, not only when state arrives.
const now = useNow({ interval: 1000 })

const pages = computed(() => pageCounts(props.research))

const title = computed(() => {
  if (props.research.writing) {
    return t('research.writing')
  }
  const n = props.research.scouts?.length
  return n ? t('research.scouts', { n }) : t('research.researching')
})

const elapsed = computed(() => {
  const s = Math.max(0, Math.floor((now.value.getTime() - props.research.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
</script>

<template>
  <Card class="w-full">
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        <Loader :size="16" />
        <!-- The clock bounds the reading, not the writing: a report took four minutes once, with
             this card saying "Researching" past the two minutes the preset promised. -->
        {{ title }}
      </CardTitle>
      <CardDescription>{{ props.research.topic }}</CardDescription>
    </CardHeader>
    <!-- While scouts are out the round totals are all zero, which read as a hang for two minutes;
         the per-scout rows are what the parent hears from them as they work. -->
    <CardContent v-if="props.research.scouts" class="space-y-1.5 text-sm text-muted-foreground">
      <div v-for="s in props.research.scouts" :key="s.angle" class="flex items-baseline gap-3">
        <span class="min-w-0 flex-1 truncate">{{ s.angle }}</span>
        <span class="shrink-0 tabular-nums">{{ t('research.searchCount', { n: s.searches }) }} · {{ t('research.pageCount', { n: s.reads }) }}</span>
      </div>
      <div class="flex items-center gap-x-6 pt-1">
        <span>{{ t('research.elapsed', { t: elapsed }) }}</span>
        <Button class="ml-auto" size="sm" variant="ghost" @click="emit('stop')"> {{ t('research.stop') }} </Button>
      </div>
    </CardContent>
    <CardContent v-else class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
      <span>{{ t('research.round', { n: props.research.round }) }}</span>
      <span>{{ pageLabel(pages) }}</span>
      <!-- Named while the run is still going, because a wave losing pages to a rate limit can still
           be stopped — after the report it is only an explanation. -->
      <span v-if="pages.lost">{{ t('research.unreachable', { n: pages.lost }) }}</span>
      <span>{{ t('research.openQuestions', { n: props.research.openQuestions.length }) }}</span>
      <!-- Absent rather than "0 tokens" when the provider reports no usage: zero would read as free. -->
      <span v-if="props.research.tokens">{{ formatTokens(props.research.tokens) }} tokens</span>
      <span>{{ elapsed }} elapsed</span>
      <Button class="ml-auto" size="sm" variant="ghost" @click="emit('stop')"> {{ t('research.stop') }} </Button>
    </CardContent>
  </Card>
</template>
