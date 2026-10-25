'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, type LocaleStore } from './locale-store';

/**
 * The locale a route's URL names (NFR-02, audit gap 5): `ar-EG` inside `app/ar` (the Arabic
 * public pages), `undefined` everywhere else. `useActiveLocale` renders with it on the server, so
 * the prerendered HTML is already Arabic, and keeps it on the client while the tab's own locale is
 * in another language — the path decides an Arabic page's language, the switch leaves it.
 */
const RouteLocaleContext = createContext<DisplayLocale | undefined>(undefined);

/** The locale the current route's URL names, or `undefined` when the URL names none. */
export function useRouteLocale(): DisplayLocale | undefined {
  return useContext(RouteLocaleContext);
}

/** The primary language subtag, lower-cased (`ar-EG` → `ar`). */
export function languageOf(locale: string): string {
  return (locale.split('-')[0] ?? '').toLowerCase();
}

/**
 * Provides the route's locale and makes it the tab's active locale (persisted like `?lang=`), so a
 * client navigation into `/ar` moves `lang`/`dir`, the formatters and the next load along with it.
 * A tab already in another variant of the same language keeps it.
 */
export function RouteLocaleProvider({
  locale,
  children,
  store = activeLocale,
}: {
  locale: DisplayLocale;
  children: ReactNode;
  store?: LocaleStore;
}) {
  useEffect(() => {
    if (languageOf(store.get()) !== languageOf(locale)) store.set(locale);
  }, [locale, store]);

  return <RouteLocaleContext.Provider value={locale}>{children}</RouteLocaleContext.Provider>;
}
