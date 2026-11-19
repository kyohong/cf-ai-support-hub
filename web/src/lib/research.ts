import { t } from '@/i18n'
import type { ResearchState } from '@/types'

/**
 * `visited` is every URL a request was spent on; `read` is the ones that produced content. The card
 * printed the first under the word "read", so a run losing half its pages to a provider's rate
 * limit looked like a thorough one.
 *
 * `read` is absent only in a seeded fixture, and absent is **unknown, not zero** — zero would
 * report every page as lost.
 */
export function pageCounts(research: ResearchState): { read?: number; total: number; lost: number } {
  const { visited, read } = research
  return read === undefined
    ? { total: visited.length, lost: 0 }
    : { read, total: visited.length, lost: visited.length - read }
}

/** The card's page sentence, translated here so both research cards read the same. */
export function pageLabel(pages: { read?: number; total: number }): string {
  return pages.read === undefined
    ? t('research.pagesTotal', { n: pages.total })
    : t('research.pagesRead', { n: pages.read })
}
