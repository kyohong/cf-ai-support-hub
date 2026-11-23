<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { LoaderCircleIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, UserIcon, UsersIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/useToasts'
import { memoriesApi, type MemoryItem } from '@/useBots'
import { t } from '@/i18n'

const props = defineProps<{ botId: string }>()

const items = ref<MemoryItem[]>([])
const loading = ref(false)
const busy = ref(false)

/** Whose profile is on screen: the operator's own ("personal") or one visitor's. */
type Scope = { type: 'personal' } | { type: 'visitor'; ownerId: string }
const scope = ref<Scope>({ type: 'personal' })

const CATEGORIES = ['profile', 'preference', 'context', 'constraint'] as const
const CATEGORY_CLASS: Record<string, string> = {
  profile: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  preference: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  context: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  constraint: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
}

const visitorIds = computed(() =>
  [...new Set(items.value.filter((m) => m.owner_type === 'visitor').map((m) => m.owner_id))].sort(),
)
const visible = computed(() =>
  items.value.filter((m) => (scope.value.type === 'personal' ? m.owner_type === 'user' : m.owner_type === 'visitor' && m.owner_id === (scope.value as { ownerId: string }).ownerId)),
)
/** Cards grouped by category, categories in a fixed order. */
const grouped = computed(() =>
  CATEGORIES.map((category) => ({ category, rows: visible.value.filter((m) => m.category === category) })).filter(
    (g) => g.rows.length,
  ),
)
const newCategory = ref('context')
const newContent = ref('')
const adding = ref(false)
const editingId = ref<string | null>(null)
const editText = ref('')
const editCategory = ref('context')
const confirmingClear = ref(false)

const scopeParams = computed(() =>
  scope.value.type === 'personal'
    ? { owner_type: 'user' as const, owner_id: undefined }
    : { owner_type: 'visitor' as const, owner_id: (scope.value as { ownerId: string }).ownerId },
)

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await memoriesApi.listAll(props.botId)
  } catch (err) {
    toast(t('bothub.memoryLoadFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(
  () => props.botId,
  () => {
    scope.value = { type: 'personal' }
    void load()
  },
)

function startEdit(memory: MemoryItem): void {
  editingId.value = memory.id
  editText.value = memory.content
  editCategory.value = CATEGORIES.includes(memory.category as (typeof CATEGORIES)[number])
    ? memory.category
    : 'context'
}

async function saveEdit(): Promise<void> {
  const content = editText.value.trim()
  if (!editingId.value || !content) {
    return
  }
  busy.value = true
  try {
    const { memory } = await memoriesApi.update(props.botId, editingId.value, {
      content,
      category: editCategory.value,
    })
    items.value = items.value.map((m) => (m.id === memory.id ? memory : m))
    editingId.value = null
    toast(t('bothub.memorySaved'))
  } catch (err) {
    toast(t('bothub.memorySaveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}

async function add(): Promise<void> {
  const content = newContent.value.trim()
  if (!content) {
    return
  }
  busy.value = true
  try {
    const { memory } = await memoriesApi.add(props.botId, { ...scopeParams.value, category: newCategory.value, content })
    items.value = [memory, ...items.value]
    newContent.value = ''
    adding.value = false
    toast(t('bothub.memorySaved'))
  } catch (err) {
    toast(t('bothub.memorySaveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}

async function remove(memory: MemoryItem): Promise<void> {
  busy.value = true
  try {
    await memoriesApi.remove(props.botId, memory.id)
    items.value = items.value.filter((m) => m.id !== memory.id)
  } catch (err) {
    toast(t('bothub.memorySaveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}

async function clearAll(): Promise<void> {
  busy.value = true
  try {
    await memoriesApi.clear(props.botId, scopeParams.value.owner_type, scopeParams.value.owner_id)
    confirmingClear.value = false
    await load()
    toast(t('bothub.memoryCleared'))
  } catch (err) {
    toast(t('bothub.memorySaveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <!-- Scope switcher: the operator's own profile vs. one visitor profile at a time -->
    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        class="h-7 shrink-0 px-2.5 text-xs"
        :variant="scope.type === 'personal' ? 'default' : 'ghost'"
        @click="scope = { type: 'personal' }"
      >
        <UserIcon class="size-3.5" /> {{ t('bothub.memoryPersonal') }}
      </Button>
      <Button
        v-for="visitor in visitorIds"
        :key="visitor"
        size="sm"
        class="h-7 shrink-0 max-w-52 px-2.5 text-xs"
        :variant="scope.type === 'visitor' && scope.ownerId === visitor ? 'default' : 'ghost'"
        @click="scope = { type: 'visitor', ownerId: visitor }"
      >
        <UsersIcon class="size-3.5 shrink-0" /> {{ visitor }}
      </Button>
      <span class="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
        {{ t('bothub.memoryCount', { n: visible.length }) }}
        <Button variant="ghost" size="sm" class="h-7 w-7 p-0" :aria-label="t('app.refresh')" @click="load">
          <RefreshCwIcon class="size-3.5" :class="loading ? 'animate-spin' : ''" />
        </Button>
      </span>
    </div>

    <!-- Add + clear -->
    <div class="flex items-center justify-between gap-2">
      <Button size="sm" @click="adding = !adding">
        <PlusIcon class="size-3.5" /> {{ t('bothub.memoryAdd') }}
      </Button>
      <template v-if="!confirmingClear">
        <Button variant="ghost" size="sm" class="text-destructive" :disabled="!visible.length" @click="confirmingClear = true">
          <Trash2Icon class="size-3.5" /> {{ t('bothub.memoryClear') }}
        </Button>
      </template>
      <template v-else>
        <span class="text-muted-foreground text-xs">{{ t('bothub.memoryClearConfirm') }}</span>
        <Button variant="outline" size="sm" @click="confirmingClear = false">{{ t('bothub.memoryCancel') }}</Button>
        <Button variant="destructive" size="sm" :disabled="busy" @click="clearAll">{{ t('bothub.memoryClear') }}</Button>
      </template>
    </div>

    <div v-if="adding" class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground text-xs">{{ t('bothub.memoryCategory') }}</span>
        <Select v-model="newCategory">
          <SelectTrigger class="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="category in CATEGORIES" :key="category" :value="category">{{ category }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea v-model="newContent" rows="2" :placeholder="t('bothub.memoryPlaceholder')" />
      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="adding = false">{{ t('bothub.memoryCancel') }}</Button>
        <Button size="sm" :disabled="busy || !newContent.trim()" @click="add">
          <LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" /> {{ t('bothub.memorySave') }}
        </Button>
      </div>
    </div>

    <p v-if="!loading && !visible.length" class="text-muted-foreground py-6 text-center text-sm">
      {{ t('bothub.memoryEmpty') }}
    </p>

    <div v-for="group in grouped" :key="group.category" class="grid gap-2">
      <span
        class="w-fit rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
        :class="CATEGORY_CLASS[group.category]"
      >
        {{ group.category }}
      </span>
      <ul class="grid gap-2">
        <li v-for="memory in group.rows" :key="memory.id" class="rounded-xl border border-border/70 bg-card/60 p-3">
          <template v-if="editingId === memory.id">
            <div class="grid gap-2">
              <div class="flex items-center gap-2">
                <span class="text-muted-foreground text-xs">{{ t('bothub.memoryCategory') }}</span>
                <Select v-model="editCategory">
                  <SelectTrigger class="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="category in CATEGORIES" :key="category" :value="category">
                      {{ category }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Textarea v-model="editText" rows="2" />
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="sm" @click="editingId = null">{{ t('bothub.memoryCancel') }}</Button>
                <Button size="sm" :disabled="busy || !editText.trim()" @click="saveEdit">{{ t('bothub.memorySave') }}</Button>
              </div>
            </div>
          </template>
          <template v-else>
            <p class="text-sm whitespace-pre-wrap">{{ memory.content }}</p>
            <div class="mt-1.5 flex items-center gap-1">
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="startEdit(memory)">
                <PencilIcon class="size-3" /> {{ t('bothub.memoryEdit') }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs text-destructive"
                :disabled="busy"
                @click="remove(memory)"
              >
                <Trash2Icon class="size-3" /> {{ t('bothub.memoryDelete') }}
              </Button>
              <span class="text-muted-foreground ml-auto text-[10px]">
                {{ new Date(memory.updated_at).toLocaleString() }}
              </span>
            </div>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>
