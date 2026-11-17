'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { DisplayLocale } from '../api/display-preferences';
import type { DisplayFormat } from './display-format';
import { DEFAULT_LOCALE } from './locale-store';
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
  return (
    <RenderedDisplayContext.Provider value={value}>{children}</RenderedDisplayContext.Provider>
  );
}
