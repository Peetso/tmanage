'use client';

import { useCallback } from 'react';
import { translate, type MessageKey } from './t';
import { useActiveLocale } from './use-active-locale';

/**
 * The message lookup bound to the active locale (i18n, I18N-03/05/06). A component calls
 * `const t = useT()` and then `t('some.key')`; it re-renders with the new strings when the member
 * changes locale. The key is typed, so a typo is a compile error.
 */
export function useT(): (key: MessageKey) => string {
  const locale = useActiveLocale();
  return useCallback((key: MessageKey) => translate(locale, key), [locale]);
}
