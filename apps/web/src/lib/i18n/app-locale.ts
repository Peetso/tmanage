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
