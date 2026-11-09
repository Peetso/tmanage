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
 * The locale a calendar or chat date is drawn in (FIX4 item 8): the member's locale, with Arabic
 * kept on Latin digits as the rest of the product writes them ("31 أكتوبر، 23:30"), and English in
 * the approved en-GB shape ("Tue 20 Oct") unless `english` names another. An Arabic member read
 * "Oct 31, 23:30" in chat and "MON 2" in the calendar because those calls passed `undefined` or a
 * fixed 'en-GB'.
 */
export function appDateLocale(
  locale: string = activeLocale.get(),
  english: string = 'en-GB',
): string {
  const lower = locale.toLowerCase();
  if (lower.startsWith('ar')) return lower.includes('-u-') ? locale : `${locale}-u-nu-latn`;
  if (lower.startsWith('en')) return english;
  return locale;
}
