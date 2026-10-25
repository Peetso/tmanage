'use client';

import type { ReactNode } from 'react';
import type { DisplayLocale } from '../../lib/api/display-preferences';
import { ServerLocaleContext } from '../../lib/i18n/use-active-locale';

/**
 * Hands the locale the root layout rendered this request in (saved-locale cookie or `?lang=`) to
 * `useActiveLocale`'s server snapshot, so the first render and hydration speak that language.
 */
export function ServerLocaleProvider({
  locale,
  children,
}: {
  locale: DisplayLocale;
  children: ReactNode;
}) {
  return <ServerLocaleContext.Provider value={locale}>{children}</ServerLocaleContext.Provider>;
}
