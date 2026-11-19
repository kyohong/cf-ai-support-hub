<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDownIcon, MicroscopeIcon, MessageSquareIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { t } from '@/i18n'
import type { ChatMode } from '@/types'

const mode = defineModel<ChatMode>({ required: true })

const modes = computed<Array<{ id: ChatMode; label: string; hint: string }>>(() => [
  { id: 'chat', label: t('composer.modeChat'), hint: t('composer.modeChatHint') },
  { id: 'research', label: t('composer.modeResearch'), hint: t('composer.modeResearchHint') },
])
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[11px]">
        <component :is="mode === 'research' ? MicroscopeIcon : MessageSquareIcon" class="size-3.5" />
        {{ mode === 'research' ? t('composer.modeResearch') : t('composer.modeChat') }}
        <ChevronDownIcon class="size-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-64">
      <DropdownMenuItem v-for="m in modes" :key="m.id" class="flex-col items-start gap-0.5" @select="mode = m.id">
        <span class="font-medium text-sm">{{ m.label }}</span>
        <span class="text-muted-foreground text-xs">{{ m.hint }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
