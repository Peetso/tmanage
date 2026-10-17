import type { DisplayLocale } from '../api/display-preferences';

/**
 * i18n (NFR-02, I18N-01) — which way the document reads.
 *
 * `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL` requires the shell to mirror for Arabic: `dir`
 * flips to `rtl`, and the CSS throughout already uses logical properties so the flip is a value
 * change rather than a rewrite (see `app/layout.tsx`). The one fact that decides the flip is the
 * active locale's script, so it lives here, as a pure function, rather than inline at the one
 * place that applies it — a unit can then prove `ar-EG -> rtl` and `en-US -> ltr` without a DOM.
 *
 * Right-to-left is a property of the *script*, not the region, so the rule is on the language
 * subtag (`ar`, and the other RTL scripts named by the Unicode CLDR: Hebrew, Persian, Urdu and
 * the right-to-left Arabic-script languages). TManage ships only `ar-EG` today; the broader set
 * keeps a future locale from being added to the allowlist and silently rendering left-to-right.
 */

export type TextDirection = 'ltr' | 'rtl';

/** Language subtags whose script is written right-to-left (Unicode CLDR `rtl` scripts). */
const RTL_LANGUAGE_SUBTAGS: ReadonlySet<string> = new Set([
  'ar', // Arabic
  'he', // Hebrew
  'fa', // Persian / Farsi
  'ur', // Urdu
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'yi', // Yiddish
  'dv', // Divehi
]);

/**
 * The writing direction for a BCP-47 locale. The primary language subtag (the part before the
 * first `-`) decides it, lower-cased so `AR-eg` and `ar-EG` agree; an unknown or malformed
 * locale is left-to-right, the safe default for the Latin-script shell.
 */
export function localeDirection(locale: string): TextDirection {
  const primarySubtag = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGE_SUBTAGS.has(primarySubtag) ? 'rtl' : 'ltr';
}

/** Narrowed overload for the allowlisted display locales, so call sites stay inside the set. */
export function displayLocaleDirection(locale: DisplayLocale): TextDirection {
  return localeDirection(locale);
}
