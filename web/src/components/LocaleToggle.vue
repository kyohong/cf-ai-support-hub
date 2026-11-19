<script setup lang="ts">
import { LanguagesIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { t, toggleLocale } from '@/i18n'
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="h-7 gap-1 px-2 text-[11px]"
    :aria-label="t('locale.switch')"
    :title="t('locale.switch')"
    @click="toggleLocale"
  >
    <LanguagesIcon class="size-3.5" />
    {{ t('locale.otherLabel') }}
  </Button>
</template>
