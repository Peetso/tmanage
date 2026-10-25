'use client';

import { useSyncExternalStore } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, DEFAULT_LOCALE, type LocaleStore } from './locale-store';
import { languageOf, useRouteLocale } from './route-locale';

/**
 * Subscribe a component to the active locale (i18n, NFR-02). Re-renders when the locale changes,
 * through `useSyncExternalStore` so a concurrent render reads a consistent value. The server
 * snapshot is the shipped default because the pages are static: the HTML's *text* is English, and
 * hydration must read the same value or React would report a mismatch. The document's `lang`/`dir`
 * do not wait for this — the `<head>` boot script (`locale-boot.ts`) sets them before the first
 * paint from the same rules the store's client snapshot uses, and `LocaleDirectionProvider` reads
 * the store directly — so only the words change after hydration, never the direction.
 *
 * Under a route that names its locale (the Arabic public pages, `route-locale.tsx`) that locale is
 * the server snapshot, so the prerendered HTML is Arabic and hydrates as Arabic, and it stays the
 * answer while the store holds another language; a variant of the same language (`ar-SA` on an
 * `ar-EG` page) is kept for its formats.
 */
export function useActiveLocale(store: LocaleStore = activeLocale): DisplayLocale {
  const routeLocale = useRouteLocale();
  const live = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => routeLocale ?? DEFAULT_LOCALE,
  );
  if (routeLocale === undefined) return live;
  return languageOf(live) === languageOf(routeLocale) ? live : routeLocale;
}
