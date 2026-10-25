'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import { activeLocale, DEFAULT_LOCALE, type LocaleStore } from './locale-store';

/**
 * The locale this request was rendered in on the server (`ServerLocaleProvider`, fed by the root
 * layout from the saved-locale cookie and `?lang=`). Without a provider it is the shipped default.
 */
export const ServerLocaleContext = createContext<DisplayLocale>(DEFAULT_LOCALE);

/**
 * Subscribe a component to the active locale (i18n, NFR-02). Re-renders when the locale changes,
 * through `useSyncExternalStore` so a concurrent render reads a consistent value. The server
 * snapshot is the locale the root layout rendered the request in ({@link ServerLocaleContext}),
 * so the HTML's text is already Arabic for a visitor who chose Arabic, and hydration reads the
 * same value. The client snapshot follows the same order (`?lang=`, then the cookie), so the two
 * agree; only a browser that saved its choice in `localStorage` alone still changes words after
 * hydration — and its cookie is written then, so its next load is rendered right.
 */
export function useActiveLocale(store: LocaleStore = activeLocale): DisplayLocale {
  const serverLocale = useContext(ServerLocaleContext);
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => serverLocale,
  );
}
