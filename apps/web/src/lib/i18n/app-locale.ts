import { withNumerals } from './display-format';
import { activeLocale } from './locale-store';

/**
 * The member's saved display locale, for an `Intl`/`toLocale*` call that has no hook to hand.
 *
 * `undefined` there means the *browser's* locale, so an Arabic member on an English-language
 * browser read "10/31/2026, 11:30:45 PM" beside Arabic dates on the same page (2026-10-31 live
 * test). Every such call site passes this instead, so one page speaks one language.
 */
export function appLocale(): string {
  return activeLocale.get();
}

/**
 * {@link appLocale} as the tag to hand to `Intl`/`toLocale*`: the member's locale, unchanged in
 * every other way, with the app's digit rule applied ({@link withNumerals}: Latin digits unless
 * the member chose others). `appLocale()` itself stays the bare locale for comparisons and routes.
 */
export function appIntlLocale(): string {
  return withNumerals(appLocale());
}

/**
 * The locale a date or number is drawn in (FIX4 item 8, AR-DIGITS): the member's locale with the
 * app's digit rule applied ({@link withNumerals}: Latin digits by default in every locale, Arabic
 * included, as every Figma frame writes them; the member's saved numerals when they chose them),
 * and English in the approved en-GB shape ("Tue 20 Oct") unless `english` names another. An
 * Arabic member read "Oct 31, 23:30" in chat and "MON 2" in the calendar because those calls
 * passed `undefined` or a fixed 'en-GB'.
 *
 * Screens never write `-u-nu-latn` or `numberingSystem` by hand; they pass their locale here.
 */
export function appDateLocale(
  locale: string = activeLocale.get(),
  english: string = 'en-GB',
): string {
  return withNumerals(locale.toLowerCase().startsWith('en') ? english : locale);
}
