<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RefreshCwIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { toast } from '@/useToasts'
import { leadsApi, type LeadItem } from '@/useBots'
import { t } from '@/i18n'

const props = defineProps<{ botId: string }>()
const leads = ref<LeadItem[]>([])
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    leads.value = await leadsApi.list(props.botId)
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(
  () => props.botId,
  () => void load(),
)

const when = (iso: string) => new Date(iso).toLocaleString()
</script>

<template>
  <div class="grid gap-3">
    <div class="flex items-center justify-between">
      <p class="text-muted-foreground text-xs">{{ t('bothub.leadsHint') }}</p>
      <Button variant="outline" size="sm" :disabled="loading" @click="load">
        <RefreshCwIcon class="size-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t('app.refresh') }}
      </Button>
    </div>

    <p v-if="!loading && !leads.length" class="text-muted-foreground py-6 text-center text-sm">
      {{ t('bothub.leadsEmpty') }}
    </p>

    <ul class="grid gap-2">
      <li v-for="lead in leads" :key="lead.id" class="rounded-xl border border-border/70 bg-card/60 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <p class="font-medium text-sm">{{ lead.contact_info }}</p>
          <span
            class="rounded-full px-2 py-0.5 text-[10px]"
            :class="lead.notified ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'"
          >
            {{ lead.notified ? t('bothub.leadNotified') : t('bothub.leadNotNotified') }}
          </span>
          <span class="text-muted-foreground ml-auto text-xs">{{ when(lead.created_at) }}</span>
        </div>
        <p class="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">{{ lead.inquiry_summary }}</p>
        <p class="text-muted-foreground mt-1 text-xs">{{ t('bothub.visitor', { id: lead.visitor_id }) }}</p>
      </li>
    </ul>
  </div>
</template>
