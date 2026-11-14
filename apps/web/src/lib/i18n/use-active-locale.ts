'use client';

import { useSyncExternalStore } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, type LocaleStore } from './locale-store';
import { useRenderedDisplay } from './rendered-display';
import { languageOf, useRouteLocale } from './route-locale';

/**
 * Subscribe a component to the active locale (i18n, NFR-02). Re-renders when the locale changes,
 * through `useSyncExternalStore` so a concurrent render reads a consistent value. The server
 * snapshot is the locale the server rendered the HTML with (`rendered-display.tsx`, FIX6): on a
 * per-request page that is the member's saved locale, so the first paint is already in their
 * language and hydration reads the same value. On a prerendered page it is the shipped default; the
 * `<head>` boot script (`locale-boot.ts`) still sets `lang`/`dir` before the first paint there, and
 * the words follow after hydration.
 *
 * Under a route that names its locale (the Arabic public pages, `route-locale.tsx`) that locale is
 * the server snapshot, so the prerendered HTML is Arabic and hydrates as Arabic, and it stays the
 * answer while the store holds another language; a variant of the same language (`ar-SA` on an
 * `ar-EG` page) is kept for its formats.
 */
export function useActiveLocale(store: LocaleStore = activeLocale): DisplayLocale {
  const routeLocale = useRouteLocale();
  const rendered = useRenderedDisplay();
  const live = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => routeLocale ?? rendered.locale,
  );
  if (routeLocale === undefined) return live;
  return languageOf(live) === languageOf(routeLocale) ? live : routeLocale;
}
