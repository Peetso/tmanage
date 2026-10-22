'use client';

import { useSyncExternalStore } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, DEFAULT_LOCALE, type LocaleStore } from './locale-store';

/**
 * Subscribe a component to the active locale (i18n, NFR-02). Re-renders when the locale changes,
 * through `useSyncExternalStore` so a concurrent render reads a consistent value. The server
 * snapshot is the shipped default because the pages are static: the HTML's *text* is English, and
 * hydration must read the same value or React would report a mismatch. The document's `lang`/`dir`
 * do not wait for this — the `<head>` boot script (`locale-boot.ts`) sets them before the first
 * paint from the same rules the store's client snapshot uses, and `LocaleDirectionProvider` reads
 * the store directly — so only the words change after hydration, never the direction.
 */
export function useActiveLocale(store: LocaleStore = activeLocale): DisplayLocale {
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => DEFAULT_LOCALE,
  );
}
