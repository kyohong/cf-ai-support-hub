<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { LoaderCircleIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/useToasts'
import { knowledgeApi, type KnowledgeItem } from '@/useBots'
import { t } from '@/i18n'

const props = defineProps<{ botId: string; prefill?: string }>()

const items = ref<KnowledgeItem[]>([])
const loading = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const empty = { category: 'General', question: '', answer: '', keywords: '' }
const form = ref({ ...empty })
const batch = ref('')

watch(
  () => props.botId,
  () => {
    reset()
    void load()
  },
)

watch(
  () => props.prefill,
  (q) => {
    if (q) {
      form.value = { ...empty, question: q }
      editingId.value = null
    }
  },
)

function reset(): void {
  form.value = { ...empty }
  editingId.value = null
}

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await knowledgeApi.list(props.botId)
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function save(): Promise<void> {
  if (!form.value.question.trim() || !form.value.answer.trim()) {
    return
  }
  saving.value = true
  try {
    if (editingId.value === null) {
      await knowledgeApi.add(props.botId, form.value)
    } else {
      await knowledgeApi.update(props.botId, editingId.value, form.value)
    }
    toast(t('bothub.knowledgeSaved'))
    reset()
    await load()
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    saving.value = false
  }
}

function edit(item: KnowledgeItem): void {
  editingId.value = item.id
  form.value = {
    category: item.category,
    question: item.question,
    answer: item.answer,
    keywords: item.keywords,
  }
}

async function remove(item: KnowledgeItem): Promise<void> {
  try {
    await knowledgeApi.remove(props.botId, item.id)
    if (editingId.value === item.id) {
      reset()
    }
    await load()
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  }
}

async function importBatch(): Promise<void> {
  if (!batch.value.trim()) {
    return
  }
  saving.value = true
  try {
    const res = await knowledgeApi.importBatch(props.botId, batch.value)
    toast(t('bothub.imported', { n: res.imported }))
    batch.value = ''
    await load()
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="grid gap-4">
    <div class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
      <div class="grid grid-cols-1 gap-2 md:grid-cols-[160px_1fr]">
        <label class="grid gap-1">
          <span class="text-muted-foreground text-xs">{{ t('bothub.category') }}</span>
          <Input v-model="form.category" :placeholder="t('bothub.categoryPlaceholder')" />
        </label>
        <label class="grid gap-1">
          <span class="text-muted-foreground text-xs">{{ t('bothub.question') }}</span>
          <Input v-model="form.question" :placeholder="t('bothub.questionPlaceholder')" />
        </label>
      </div>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.answer') }}</span>
        <Textarea v-model="form.answer" rows="4" :placeholder="t('bothub.answerPlaceholder')" />
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.keywords') }}</span>
        <Input v-model="form.keywords" :placeholder="t('bothub.keywordsPlaceholder')" />
      </label>
      <div class="flex justify-end gap-2">
        <Button v-if="editingId !== null" variant="ghost" size="sm" @click="reset">{{ t('app.cancel') }}</Button>
        <Button size="sm" :disabled="saving || !form.question.trim() || !form.answer.trim()" @click="save">
          <LoaderCircleIcon v-if="saving" class="size-3.5 animate-spin" />
          <PlusIcon v-else class="size-3.5" />
          {{ editingId === null ? t('bothub.addEntry') : t('bothub.updateEntry') }}
        </Button>
      </div>
    </div>

    <div v-if="loading && !items.length" class="text-muted-foreground py-6 text-center text-sm">
      {{ t('app.loading') }}
    </div>
    <p v-else-if="!items.length" class="text-muted-foreground py-2 text-sm">{{ t('bothub.knowledgeEmpty') }}</p>
    <ul v-else class="grid gap-2">
      <li
        v-for="item in items"
        :key="item.id"
        class="rounded-xl border border-border/70 bg-card/60 p-3"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="text-muted-foreground text-xs">[{{ item.category }}]</p>
            <p class="mt-0.5 font-medium text-sm">{{ item.question }}</p>
            <p class="text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap text-xs">{{ item.answer }}</p>
            <p v-if="item.keywords" class="text-muted-foreground mt-1 text-xs">#{{ item.keywords }}</p>
          </div>
          <Button variant="ghost" size="icon-sm" :aria-label="t('bothub.editEntry')" @click="edit(item)">
            <PencilIcon class="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" :aria-label="t('bothub.deleteEntry')" @click="remove(item)">
            <Trash2Icon class="size-3.5" />
          </Button>
        </div>
      </li>
    </ul>

    <div class="grid gap-2 rounded-xl border border-dashed border-border p-3">
      <p class="font-medium text-sm">{{ t('bothub.batchTitle') }}</p>
      <p class="text-muted-foreground text-xs">{{ t('bothub.batchHint') }}</p>
      <Textarea v-model="batch" rows="5" :placeholder="t('bothub.batchPlaceholder')" />
      <div class="flex justify-end">
        <Button variant="outline" size="sm" :disabled="saving || !batch.trim()" @click="importBatch">
          <UploadIcon class="size-3.5" />
          {{ t('bothub.import') }}
        </Button>
      </div>
    </div>
  </div>
</template>
