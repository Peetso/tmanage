'use client';

import type { CompareLanguage } from '../../../../content/compare/compare-entries';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { languageOf } from '../../../../lib/i18n/route-locale';

/** Arabic for an Arabic reader (route `/ar/compare…` or an Arabic tab), English for everyone else. */
export function useCompareLanguage(): CompareLanguage {
  return languageOf(useActiveLocale()) === 'ar' ? 'ar' : 'en';
}
