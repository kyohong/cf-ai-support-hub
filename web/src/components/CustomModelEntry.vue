<script setup lang="ts">
import { computed } from 'vue'
import { SparklesIcon } from '@lucide/vue'
import { CommandItem, useCommand } from '@/components/ui/command'
import { t } from '@/i18n'

const emit = defineEmits<{ (e: 'pick', id: string): void }>()

/** The live search text comes from the Command context: type any model id and it becomes
 *  selectable verbatim — Enter picks it when it is the only match, click always works. */
const { filterState } = useCommand()
const query = computed(() => filterState.search.trim())
</script>

<template>
  <CommandItem :value="query" class="gap-2" @select="emit('pick', query)">
    <SparklesIcon class="shrink-0" />
    <span class="truncate">{{ t('model.customOption', { q: query }) }}</span>
  </CommandItem>
</template>
