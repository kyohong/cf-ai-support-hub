<script setup lang="ts">
import { ref, watch } from 'vue'
import { BrainIcon, DatabaseIcon, SparklesIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { toast } from '@/useToasts'
import { landingRpc } from '@/useDashboard'
import { t } from '@/i18n'
import type { MemoryWall as MemoryWallData } from '@/types'

const open = defineModel<boolean>('open', { default: false })
const wall = ref<MemoryWallData | null>(null)
const busy = ref(false)

watch(open, (v) => {
  if (v) {
    void load()
  }
})

async function load(): Promise<void> {
  busy.value = true
  try {
    wall.value = await landingRpc<MemoryWallData>('listMemoryWall')
  } catch (err) {
    toast(t('wall.loadFailed', { err: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="ghost" class="size-7 p-0" :aria-label="t('wall.triggerAria')">
        <DatabaseIcon class="size-4" />
      </Button>
    </DialogTrigger>
    <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ t('wall.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('wall.desc') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="busy && !wall" class="text-muted-foreground py-8 text-center text-sm">{{ t('wall.loading') }}</div>

      <template v-else>
        <section>
          <h3 class="mb-2 flex items-center gap-1.5 font-medium text-sm">
            <BrainIcon class="size-4" /> {{ t('wall.memories', { n: wall?.memories.length ?? 0 }) }}
          </h3>
          <p v-if="!wall?.memories.length" class="text-muted-foreground px-1 text-sm">
            {{ t('wall.emptyMemories') }}
          </p>
          <div v-else class="grid gap-2.5 sm:grid-cols-2">
            <div
              v-for="m in wall.memories"
              :key="m.slug"
              class="rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm backdrop-blur-sm transition-shadow hover:shadow-md"
            >
              <p class="truncate font-medium text-sm">{{ m.slug }}</p>
              <p class="mt-1 line-clamp-3 text-muted-foreground text-xs">{{ m.description || t('wall.noDescription') }}</p>
            </div>
          </div>
        </section>

        <section>
          <h3 class="mb-2 flex items-center gap-1.5 font-medium text-sm">
            <SparklesIcon class="size-4" /> {{ t('wall.skills', { n: wall?.skills.length ?? 0 }) }}
          </h3>
          <p v-if="!wall?.skills.length" class="text-muted-foreground px-1 text-sm">
            {{ t('wall.emptySkills') }}
          </p>
          <div v-else class="grid gap-2.5 sm:grid-cols-2">
            <div
              v-for="s in wall.skills"
              :key="s.slug"
              class="rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm backdrop-blur-sm transition-shadow hover:shadow-md"
            >
              <p class="truncate font-medium text-sm">/{{ s.slug }}</p>
              <p class="mt-1 line-clamp-2 text-muted-foreground text-xs">{{ s.description }}</p>
              <p class="mt-1.5 text-muted-foreground text-xs">{{ t('wall.used', { n: s.useCount }) }}</p>
            </div>
          </div>
        </section>
      </template>

      <DialogFooter>
        <Button variant="outline" size="sm" class="mr-auto" @click="load"> {{ t('app.refresh') }} </Button>
        <Button variant="outline" size="sm" @click="open = false"> {{ t('app.close') }} </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
