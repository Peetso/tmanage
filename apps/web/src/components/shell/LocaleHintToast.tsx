'use client';

import { useEffect, useState } from 'react';
import { Button, Toast, ToastRegion } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  OFFERED_LOCALES,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import { askLocaleHint, type LocaleHint } from '../../lib/i18n/locale-hint';
import { writeLocaleSource } from '../../lib/i18n/locale-source';
import { activeLocale, type LocaleStore } from '../../lib/i18n/locale-store';
import { useT } from '../../lib/i18n/use-t';

/**
 * **First-visit language toast (R12 R2; Figma "Languages (R2)" 501:29333).**
 *
 * Mounted once in the root layout. When the tab booted with no saved language and nobody has
 * chosen one, it asks for the guess once (`locale-hint.ts`), applies it through
 * {@link LocaleStore.applyHint} (saved with source `auto`) and — only when the language actually
 * changed — says so: "Language set to Español from your location · Change · Keep". Keep turns the
 * guess into a choice; Change opens the offered list, and a pick there is a choice too.
 */
const askLive = (): Promise<LocaleHint> => askLocaleHint(browserApiClient());

export function LocaleHintToast({
  store = activeLocale,
  ask = askLive,
}: {
  store?: LocaleStore;
  ask?: () => Promise<LocaleHint>;
}) {
  const t = useT();
  const [applied, setApplied] = useState<LocaleHint | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    if (!store.bootedWithoutChoice) return;
    let live = true;
    const before = store.get();
    void ask().then((hint) => {
      if (!live) return;
      if (store.applyHint(hint.locale) && hint.locale !== before) setApplied(hint);
    });
    return () => {
      live = false;
    };
  }, [store, ask]);

  const close = () => {
    setApplied(null);
    setChanging(false);
  };

  return (
    <ToastRegion aria-label={t('LocaleHint.region')}>
      {applied ? (
        <Toast tone="neutral" onDismiss={close} dismissLabel={t('LocaleHint.dismiss')}>
          <span className="tm-toast__body">
            {t(
              applied.source === 'geo' ? 'LocaleHint.fromLocation' : 'LocaleHint.fromBrowser',
            ).replace('{language}', localeNativeName(applied.locale))}
          </span>
          {changing ? (
            <select
              aria-label={t('LanguagePicker.label')}
              value={store.get()}
              onChange={(event) => {
                store.set(event.target.value as (typeof OFFERED_LOCALES)[number]);
                close();
              }}
            >
              {OFFERED_LOCALES.map((value) => (
                <option key={value} value={value} lang={localeLangAttribute(value)}>
                  {localeNativeName(value)}
                </option>
              ))}
            </select>
          ) : (
            <>
              <Button type="button" tone="text" size="compact" onClick={() => setChanging(true)}>
                {t('LocaleHint.change')}
              </Button>
              <Button
                type="button"
                tone="text"
                size="compact"
                onClick={() => {
                  writeLocaleSource('chosen');
                  close();
                }}
              >
                {t('LocaleHint.keep')}
              </Button>
            </>
          )}
        </Toast>
      ) : null}
    </ToastRegion>
  );
}
