<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckIcon, CopyIcon, LoaderCircleIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/useToasts'
import { useBots, type Bot } from '@/useBots'
import { t } from '@/i18n'

const props = defineProps<{ bot: Bot }>()
const emit = defineEmits<{ saved: [bot: Bot]; deleted: [] }>()
const { update, remove } = useBots()

const form = ref({ ...props.bot })
const saving = ref(false)
const copied = ref(false)
const confirming = ref(false)

watch(
  () => props.bot,
  (bot) => {
    form.value = { ...bot }
    confirming.value = false
  },
)

/** The closing tag is assembled: a literal one would end this SFC's script block mid-file. */
const CLOSE_TAG = '<' + '/script>'
const snippet = computed(
  () => `<script src="${location.origin}/widget.js" data-bot-id="${props.bot.id}" defer>${CLOSE_TAG}`,
)

async function save(): Promise<void> {
  saving.value = true
  try {
    const saved = await update(props.bot.id, { ...form.value })
    toast(t('bothub.saved'))
    emit('saved', saved)
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    saving.value = false
  }
}

async function del(): Promise<void> {
  try {
    await remove(props.bot.id)
    emit('deleted')
  } catch (err) {
    toast(t('bothub.saveFailed', { err: err instanceof Error ? err.message : String(err) }))
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(snippet.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    toast(t('bothub.copyFailed'))
  }
}
</script>

<template>
  <div class="grid gap-3">
    <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.name') }}</span>
        <Input v-model="form.name" :aria-label="t('bothub.name')" />
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.enabled') }}</span>
        <button
          type="button"
          role="switch"
          :aria-checked="form.enabled"
          class="flex h-9 items-center gap-2 rounded-md border px-3 text-sm"
          @click="form.enabled = !form.enabled"
        >
          <span class="size-2 rounded-full" :class="form.enabled ? 'bg-emerald-500' : 'bg-muted-foreground'" />
          {{ form.enabled ? t('bothub.online') : t('bothub.disabled') }}
        </button>
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.autoMemory') }}</span>
        <button
          type="button"
          role="switch"
          :aria-checked="form.memory_enabled"
          class="flex h-9 items-center gap-2 rounded-md border px-3 text-sm"
          @click="form.memory_enabled = !form.memory_enabled"
        >
          <span class="size-2 rounded-full" :class="form.memory_enabled ? 'bg-emerald-500' : 'bg-muted-foreground'" />
          {{ form.memory_enabled ? t('bothub.memoryOn') : t('bothub.memoryOff') }}
        </button>
      </label>
    </div>
    <p class="text-muted-foreground -mt-1 text-xs">{{ t('bothub.autoMemoryHint') }}</p>

    <label class="grid gap-1">
      <span class="text-muted-foreground text-xs">{{ t('bothub.soul') }}</span>
      <Textarea v-model="form.soul_prompt" rows="4" :placeholder="t('bothub.soulPlaceholder')" />
    </label>

    <div class="grid gap-2 sm:grid-cols-2">
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.origins') }}</span>
        <Input v-model="form.allowed_origins" :placeholder="t('bothub.originsPlaceholder')" />
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.dailyLimit') }}</span>
        <Input v-model.number="form.daily_msg_limit" type="number" min="1" max="10000" />
      </label>
    </div>

    <label class="grid gap-1">
      <span class="text-muted-foreground text-xs">{{ t('bothub.webhook') }}</span>
      <Input v-model="form.webhook_url" :placeholder="t('bothub.webhookPlaceholder')" />
    </label>

    <div class="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.widgetTitle') }}</span>
        <Input v-model="form.widget_title" />
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.widgetGreeting') }}</span>
        <Input v-model="form.widget_greeting" />
      </label>
      <label class="grid gap-1">
        <span class="text-muted-foreground text-xs">{{ t('bothub.widgetColor') }}</span>
        <span class="flex items-center gap-2">
          <input
            v-model="form.widget_color"
            type="color"
            class="h-9 w-10 cursor-pointer rounded-md border bg-transparent p-1"
            :aria-label="t('bothub.widgetColor')"
          />
          <Input v-model="form.widget_color" class="flex-1" />
        </span>
      </label>
    </div>

    <div class="flex items-center justify-end gap-2">
      <Button v-if="!confirming" variant="ghost" size="sm" class="mr-auto text-destructive" @click="confirming = true">
        <Trash2Icon class="size-3.5" /> {{ t('bothub.deleteBot') }}
      </Button>
      <template v-else>
        <span class="text-muted-foreground mr-auto text-xs">{{ t('bothub.deleteConfirm') }}</span>
        <Button variant="outline" size="sm" @click="confirming = false">{{ t('app.cancel') }}</Button>
        <Button variant="destructive" size="sm" @click="del">{{ t('app.delete') }}</Button>
      </template>
      <Button size="sm" :disabled="saving" @click="save">
        <LoaderCircleIcon v-if="saving" class="size-3.5 animate-spin" />
        {{ t('app.save') }}
      </Button>
    </div>

    <div class="grid gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
      <div class="flex items-center justify-between gap-2">
        <p class="font-medium text-sm">{{ t('bothub.embed') }}</p>
        <Button variant="outline" size="sm" @click="copy">
          <CheckIcon v-if="copied" class="size-3.5" />
          <CopyIcon v-else class="size-3.5" />
          {{ copied ? t('bothub.copied') : t('bothub.copy') }}
        </Button>
      </div>
      <pre class="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{{ snippet }}</pre>
      <p class="text-muted-foreground text-xs">{{ t('bothub.embedHint') }}</p>
    </div>
  </div>
</template>
