'use client';

import { useEffect, type ReactNode } from 'react';
import { localeDirection } from '../../lib/i18n/direction';
import { activeLocale, type LocaleStore } from '../../lib/i18n/locale-store';

/**
 * i18n (NFR-02, I18N-01) — applies the active locale to the document.
 *
 * `app/layout.tsx` renders `<html lang="en" dir="ltr">` as the server-side baseline and inlines the
 * boot script from `locale-boot.ts`, which moves `lang`/`dir` to the tab's locale (`?lang=` or the
 * cached one) before the first paint. This client provider keeps them in step afterwards: it applies
 * the store's value on mount and whenever a member changes their locale — so Arabic reads
 * right-to-left without a reload, and the CSS logical properties the shell already uses do the
 * mirroring.
 *
 * It subscribes to the store directly rather than through `useActiveLocale`, on purpose: during
 * hydration that hook returns the *server* snapshot (`en-US`, so the text matches the static HTML),
 * and an effect keyed on it would flip an Arabic page back to `ltr` for a frame before the client
 * value arrived. Reading `store.get()` means the document only ever sees the real locale, which is
 * the same value the boot script already set — so there is no flip at all.
 *
 * It renders its children unchanged. `lang` carries the full BCP-47 tag; `dir` is derived from the
 * locale's script by {@link localeDirection}.
 */
export function LocaleDirectionProvider({
  children,
  store = activeLocale,
}: {
  children: ReactNode;
  store?: LocaleStore;
}) {
  useEffect(() => {
    const root = document.documentElement;
    const previousLang = root.lang;
    const previousDir = root.dir;
    const apply = (locale: string) => {
      root.lang = locale;
      root.dir = localeDirection(locale);
    };
    apply(store.get());
    const unsubscribe = store.subscribe(apply);
    return () => {
      unsubscribe();
      // Restore on unmount so a test (or a nested render) does not leak direction into the
      // next mount; in the real app the provider lives for the tab's lifetime.
      root.lang = previousLang;
      root.dir = previousDir;
    };
  }, [store]);

  return <>{children}</>;
}
