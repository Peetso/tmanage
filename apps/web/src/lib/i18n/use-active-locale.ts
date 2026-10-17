'use client';

import { useSyncExternalStore } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, DEFAULT_LOCALE, type LocaleStore } from './locale-store';

/**
 * Subscribe a component to the active locale (i18n, NFR-02). Re-renders when the locale changes,
 * through `useSyncExternalStore` so a concurrent render reads a consistent value. The server
 * snapshot is the shipped default — the document renders left-to-right in English until the
 * client hydrates and the store's persisted/queried value takes over, which is the correct
 * no-JavaScript baseline.
 */
export function useActiveLocale(store: LocaleStore = activeLocale): DisplayLocale {
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => DEFAULT_LOCALE,
  );
}
