'use client';

import { useCallback } from 'react';
import { translate, type MessageKey } from './t';
import { useActiveLocale } from './use-active-locale';

/**
 * `useT()` for a key that may not be in the catalogs yet.
 *
 * New keys reach `en.json`/`ar.json` through an i18n fragment that the committer merges, so a call
 * site written before the merge cannot use the typed `MessageKey`. `tOr(key, english)` returns the
 * active locale's string once the key exists and the given English text until then, never the raw
 * key. After the merge it behaves exactly like `t(key)`.
 */
export function useTOr(): (key: string, english: string) => string {
  const locale = useActiveLocale();
  return useCallback(
    (key: string, english: string) => {
      const value = translate(locale, key as MessageKey);
      return value === key ? english : value;
    },
    [locale],
  );
}
