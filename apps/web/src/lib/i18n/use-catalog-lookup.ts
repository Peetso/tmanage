'use client';

import { useCallback } from 'react';
import type { CatalogLookup } from '../ai-approval-presentation';
import { translate, type MessageKey } from './t';
import { useActiveLocale } from './use-active-locale';

/**
 * A lookup for keys built at run time (registry op ids, argument ids): the catalog string, or
 * `undefined` when neither catalog holds the key, so the caller keeps the server's English.
 */
export function useCatalogLookup(): CatalogLookup {
  const locale = useActiveLocale();
  return useCallback(
    (key: string) => {
      const text = translate(locale, key as MessageKey);
      return text === key ? undefined : text;
    },
    [locale],
  );
}
