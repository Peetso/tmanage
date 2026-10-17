import type { DisplayLocale } from '../api/display-preferences';

/**
 * i18n (NFR-02, I18N-01/04/08) — locale- and timezone-aware `Intl` formatting.
 *
 * The shell is full of `new Intl.NumberFormat(undefined, …)` and `new Intl.DateTimeFormat(
 * undefined, …)` call sites, and `undefined` means "whatever locale the browser happens to be
 * in" — never the locale the member actually saved. The same instant then reads one way for a
 * visitor from Cairo and another for one from Chicago regardless of their preference, and an
 * Arabic member sees Latin digits. These wrappers take the active locale (and, where it matters,
 * the timezone) explicitly, so a value is formatted the way the member chose, deterministically.
 *
 * They are pure and take the locale as an argument so a unit can prove `en-US`, `de-DE` and
 * `ar-EG` really diverge (grouping, decimal mark, currency placement, Arabic-Indic digits) for a
 * fixed input. `useDisplayFormatters()` binds them to the active locale for components.
 *
 * Every wrapper keeps the defensive fallback the hand-written call sites had: an unknown currency
 * code or an unparseable instant yields a readable string rather than throwing inside a render.
 */

export interface FormatContext {
  /** The active BCP-47 locale. */
  readonly locale: DisplayLocale | string;
  /** The active IANA timezone, when a wall-clock reading is wanted; omitted uses the runtime's. */
  readonly timeZone?: string;
}

function withTimeZone(
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormatOptions {
  return timeZone ? { ...options, timeZone } : options;
}

/** Format integer minor units (e.g. cents) as a currency amount in the active locale. */
export function formatMoneyMinor(
  amountMinor: number,
  currency: string,
  ctx: FormatContext,
): string {
  try {
    return new Intl.NumberFormat(ctx.locale, { style: 'currency', currency }).format(
      amountMinor / 100,
    );
  } catch {
    // An unknown currency code — show the raw major units with the code appended.
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** Format a number in the active locale (grouping, decimal mark, numbering system). */
export function formatNumber(
  value: number,
  ctx: FormatContext,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(ctx.locale, options).format(value);
}

/** Format an ISO instant as a calendar day in the active locale. Unparseable input is returned verbatim. */
export function formatDay(
  iso: string,
  ctx: FormatContext,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(ctx.locale, withTimeZone(options, ctx.timeZone)).format(at);
}

/** Format an ISO instant as a date and time in the active locale and timezone. */
export function formatDateTime(
  iso: string,
  ctx: FormatContext,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(ctx.locale, withTimeZone(options, ctx.timeZone)).format(at);
}
