<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { BookPlusIcon, RefreshCwIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { toast } from '@/useToasts'
import { conversationsApi, type ConversationItem } from '@/useBots'
import { t } from '@/i18n'

const props = defineProps<{ botId: string }>()
const emit = defineEmits<{ teach: [question: string] }>()

const threads = ref<{ visitorId: string; items: ConversationItem[] }[]>([])
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await conversationsApi.list(props.botId, true)
    threads.value = res.threads ?? []
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
      <p class="text-muted-foreground text-xs">{{ t('bothub.conversationsHint') }}</p>
      <Button variant="outline" size="sm" :disabled="loading" @click="load">
        <RefreshCwIcon class="size-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t('app.refresh') }}
      </Button>
    </div>

    <p v-if="!loading && !threads.length" class="text-muted-foreground py-6 text-center text-sm">
      {{ t('bothub.conversationsEmpty') }}
    </p>

    <div v-for="thread in threads" :key="thread.visitorId" class="rounded-xl border border-border/70 bg-card/60 p-3">
      <p class="text-muted-foreground mb-2 text-xs">{{ t('bothub.visitor', { id: thread.visitorId }) }}</p>
      <ul class="grid gap-2">
        <li v-for="item in thread.items" :key="item.id" class="group flex items-start gap-2">
          <div
            class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
            :class="item.role === 'user' ? 'bg-primary/10' : 'bg-muted'"
          >
            {{ item.content }}
            <span class="text-muted-foreground mt-1 block text-[10px]">{{ when(item.created_at) }}</span>
          </div>
          <Button
            v-if="item.role === 'user'"
            variant="ghost"
            size="sm"
            class="h-7 shrink-0 px-2 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            :title="t('bothub.teach')"
            @click="emit('teach', item.content)"
          >
            <BookPlusIcon class="size-3.5" />
            {{ t('bothub.teach') }}
          </Button>
        </li>
      </ul>
    </div>
  </div>
</template>
