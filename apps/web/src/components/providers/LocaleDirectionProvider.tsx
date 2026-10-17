'use client';

import { useEffect, type ReactNode } from 'react';
import { localeDirection } from '../../lib/i18n/direction';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';

/**
 * i18n (NFR-02, I18N-01) — applies the active locale to the document.
 *
 * `app/layout.tsx` renders `<html lang="en" dir="ltr">` as the server-side baseline: correct
 * with no JavaScript and for every Latin-script member. This client provider, mounted just
 * inside it, moves `document.documentElement`'s `lang` and `dir` to the active locale once the
 * store is known and whenever a member changes their locale — so Arabic reads right-to-left
 * without a reload, and the CSS logical properties the shell already uses do the mirroring.
 *
 * It renders its children unchanged; the only effect is on the document element, so mounting it
 * is free for every screen below. `lang` carries the full BCP-47 tag (the browser uses it for
 * hyphenation and quotation marks); `dir` is derived from the locale's script by
 * {@link localeDirection}.
 */
export function LocaleDirectionProvider({ children }: { children: ReactNode }) {
  const locale = useActiveLocale();

  useEffect(() => {
    const root = document.documentElement;
    const previousLang = root.lang;
    const previousDir = root.dir;
    root.lang = locale;
    root.dir = localeDirection(locale);
    return () => {
      // Restore on unmount so a test (or a nested render) does not leak direction into the
      // next mount; in the real app the provider lives for the tab's lifetime.
      root.lang = previousLang;
      root.dir = previousDir;
    };
  }, [locale]);

  return <>{children}</>;
}
