import { computed, ref, watch } from 'vue'
import { zh, type MessageKey } from './zh'
import { en } from './en'

export type { MessageKey }
export type Locale = 'zh' | 'en'

const STORAGE_KEY = 'app_locale'
const messages: Record<Locale, Record<MessageKey, string>> = { zh, en }

function saved(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'zh' || v === 'en' ? v : null
  } catch {
    return null
  }
}

/** Build-time default, so one image can ship as an English product without any runtime config. */
const buildDefault: Locale = import.meta.env.VITE_DEFAULT_LOCALE === 'en' ? 'en' : 'zh'

export const locale = ref<Locale>(saved() ?? buildDefault)
export const isZh = computed(() => locale.value === 'zh')

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = messages[locale.value][key] ?? zh[key] ?? key
  if (!vars) {
    return template
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

export function setLocale(next: Locale): void {
  locale.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Private mode: the switch still works for this page, it just will not survive a reload.
  }
}

export function toggleLocale(): void {
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}

function applyDocument(): void {
  document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en'
  document.title = t('app.title')
}

watch(locale, applyDocument, { immediate: true })

// A deployment can name its default language for first-time visitors. A stored choice always wins,
// and the fetch is skipped entirely when one exists.
if (!saved()) {
  void fetch('/api/config')
    .then((res) => (res.ok ? (res.json() as Promise<{ defaultLocale?: string }>) : null))
    .then((cfg) => {
      if (!localStorage.getItem(STORAGE_KEY) && (cfg?.defaultLocale === 'en' || cfg?.defaultLocale === 'zh')) {
        locale.value = cfg.defaultLocale
      }
    })
    .catch(() => {})
}
