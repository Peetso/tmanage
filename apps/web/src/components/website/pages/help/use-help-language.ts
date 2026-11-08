'use client';

import type { HelpLanguage } from '../../../../content/help/help-articles';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { languageOf } from '../../../../lib/i18n/route-locale';

/** Arabic for an Arabic reader (route `/ar/help…` or an Arabic tab), English for everyone else. */
export function useHelpLanguage(): HelpLanguage {
  return languageOf(useActiveLocale()) === 'ar' ? 'ar' : 'en';
}
