'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import type { DisplayFormat } from './display-format';
import { SITE_PARTS } from './catalog-part';
import { activeLocale, DEFAULT_LOCALE } from './locale-store';
import { useCatalog } from './use-catalog';

/**
 * FIX6 locale flash — the locale and display format the server rendered this page's HTML with.
 *
 * The root layout reads them from the request (`server-html-attributes.ts`: the saved-locale and
 * saved-format cookies, allowlisted) and passes them here, so they travel with the page. Hooks use
 * them as their server snapshot (`useActiveLocale`, `useDisplayFormatters`): the server renders the
 * member's language, and hydration reads the very same value, so a signed-in page is Arabic from
 * its first paint with no hydration mismatch. A prerendered page carries the shipped default.
 */
export interface RenderedDisplay {
  readonly locale: DisplayLocale;
  readonly format: DisplayFormat;
}

const NO_FORMAT: DisplayFormat = {};

const RenderedDisplayContext = createContext<RenderedDisplay>({
  locale: DEFAULT_LOCALE,
  format: NO_FORMAT,
});

/** What the server rendered with (the shipped default outside the provider). */
export function useRenderedDisplay(): RenderedDisplay {
  return useContext(RenderedDisplayContext);
}

export function RenderedDisplayProvider({
  value,
  children,
}: {
  value: RenderedDisplay;
  children: ReactNode;
}) {
  useCatalog(value.locale);
  // CATSPLIT: hydrate only once the tab's boot locale (an `/ar` path, `?lang=`, the cookie) is here
  // too. Otherwise the shell above a route hydrated first, and the locale published on arrival
  // updated it while the route below was still dehydrated (React #467 on /ar). Read once: a later
  // switch waits in the store, never here.
  const [boot] = useState(() => activeLocale.requestedLocale);
  useCatalog(boot, SITE_PARTS);
  return (
    <RenderedDisplayContext.Provider value={value}>{children}</RenderedDisplayContext.Provider>
  );
}
