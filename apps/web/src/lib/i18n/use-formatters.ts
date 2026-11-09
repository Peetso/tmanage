'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { displayFormat } from './display-format';
import {
  formatDateTime,
  formatDay,
  formatMoneyMinor,
  formatNumber,
  formatRelative,
  formatTime,
  type FormatContext,
} from './format';
import { useActiveLocale } from './use-active-locale';

/** The active-locale-bound formatters a component reaches for. */
export interface DisplayFormatters {
  money(amountMinor: number, currency: string): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  day(iso: string, options?: Intl.DateTimeFormatOptions): string;
  dateTime(iso: string, options?: Intl.DateTimeFormatOptions): string;
  /** FIX5 item 6b: a time of day ("16:59", "4:59 م" with Latin digits when saved so). */
  time(iso: string, options?: Intl.DateTimeFormatOptions): string;
  /** FIX5 item 6b: a relative phrase ("8 minutes ago", "قبل 8 دقائق"). */
  relative(value: number, unit: Intl.RelativeTimeFormatUnit): string;
}

/**
 * The {@link formatMoneyMinor}/{@link formatDay}/… wrappers, bound to the active locale, so a
 * component formats everything the way the member chose without threading the locale through
 * every call. Re-derives when the locale changes. A timezone can be added here once an active
 * timezone store exists; until then the formatters read the active locale and the runtime zone.
 */
export function useDisplayFormatters(): DisplayFormatters {
  const locale = useActiveLocale();
  // FIX5 item 6b (B-N7): re-derive when the saved digits or date layout arrive or change.
  const saved = useSyncExternalStore(
    (onChange) => displayFormat.subscribe(onChange),
    () => displayFormat.get(),
    () => displayFormat.get(),
  );
  return useMemo(() => {
    const ctx: FormatContext = { locale };
    return {
      money: (amountMinor, currency) => formatMoneyMinor(amountMinor, currency, ctx),
      number: (value, options) => formatNumber(value, ctx, options),
      day: (iso, options) => (options ? formatDay(iso, ctx, options) : formatDay(iso, ctx)),
      dateTime: (iso, options) =>
        options ? formatDateTime(iso, ctx, options) : formatDateTime(iso, ctx),
      time: (iso, options) => (options ? formatTime(iso, ctx, options) : formatTime(iso, ctx)),
      relative: (value, unit) => formatRelative(value, unit, ctx),
    };
    // `saved` is read by the wrappers through the store; it is listed so they re-bind on a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, saved]);
}
