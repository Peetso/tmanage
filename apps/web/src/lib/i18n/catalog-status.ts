import type { DisplayLocale } from '../api/display-preferences';

/**
 * R12 / R2 — which interface languages the pickers offer, and how far each catalog has got.
 *
 * `DISPLAY_LOCALES` (the API allowlist) is wider than what a person may pick: `ja-JP` stays valid
 * on the wire (a saved value must keep loading) but has no catalog, so no picker lists it. The
 * five newer catalogs ship as `beta` (machine-assisted, one worker per language); a native-speaker
 * review flips one to `reviewed`, and `i18n-key-parity.test.ts` then holds it to the strict rule
 * Arabic already meets.
 */

/** The locales every language picker lists, in this order. `ja-JP` is allowlisted but hidden. */
export const OFFERED_LOCALES = [
  'en-US',
  'en-GB',
  'ar-EG',
  'es-ES',
  'fr-FR',
  'pt-BR',
  'de-DE',
  'zh-CN',
] as const satisfies readonly DisplayLocale[];

export type OfferedLocale = (typeof OFFERED_LOCALES)[number];

/** The catalog languages besides English (the source of truth), by `t.ts`'s catalog name. */
export type CatalogName = 'ar' | 'es' | 'fr' | 'pt-BR' | 'de' | 'zh-CN';

export type CatalogStatus = 'reviewed' | 'beta';

export const CATALOG_STATUS: Readonly<Record<CatalogName, CatalogStatus>> = {
  ar: 'reviewed',
  es: 'beta',
  fr: 'beta',
  'pt-BR': 'beta',
  de: 'beta',
  'zh-CN': 'beta',
};

/** Each language named in itself, as every picker shows it (Figma "Languages (R2)" 501:29247). */
const NATIVE_NAMES: Readonly<Record<OfferedLocale, string>> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'ar-EG': 'العربية',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'pt-BR': 'Português (Brasil)',
  'de-DE': 'Deutsch',
  'zh-CN': '简体中文',
};

/** The language's own name for an offered locale; any other value is returned as it is. */
export function localeNativeName(locale: string): string {
  return Object.prototype.hasOwnProperty.call(NATIVE_NAMES, locale)
    ? NATIVE_NAMES[locale as OfferedLocale]
    : locale;
}

/** The `lang` attribute a native name is written in (`zh-CN` → `zh`, `pt-BR` → `pt`). */
export function localeLangAttribute(locale: string): string {
  return (locale.split('-')[0] ?? 'en').toLowerCase();
}

/** Whether the picker marks this locale "Beta" (its catalog is not reviewed yet). */
export function isBetaLocale(locale: string): boolean {
  const name = catalogNameOf(locale);
  return name !== 'en' && CATALOG_STATUS[name] === 'beta';
}

/** The catalog a BCP-47 locale reads from: ar, es, fr, pt → pt-BR, de, zh → zh-CN, else en. */
export function catalogNameOf(locale: string): CatalogName | 'en' {
  switch ((locale.split('-')[0] ?? '').toLowerCase()) {
    case 'ar':
      return 'ar';
    case 'es':
      return 'es';
    case 'fr':
      return 'fr';
    case 'pt':
      return 'pt-BR';
    case 'de':
      return 'de';
    case 'zh':
      return 'zh-CN';
    default:
      return 'en';
  }
}
