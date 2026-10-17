'use client';

import { useMemo } from 'react';
import {
  formatDateTime,
  formatDay,
  formatMoneyMinor,
  formatNumber,
  type FormatContext,
} from './format';
import { useActiveLocale } from './use-active-locale';

/** The active-locale-bound formatters a component reaches for. */
export interface DisplayFormatters {
  money(amountMinor: number, currency: string): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  day(iso: string, options?: Intl.DateTimeFormatOptions): string;
  dateTime(iso: string, options?: Intl.DateTimeFormatOptions): string;
}

/**
 * The {@link formatMoneyMinor}/{@link formatDay}/… wrappers, bound to the active locale, so a
 * component formats everything the way the member chose without threading the locale through
 * every call. Re-derives when the locale changes. A timezone can be added here once an active
 * timezone store exists; until then the formatters read the active locale and the runtime zone.
 */
export function useDisplayFormatters(): DisplayFormatters {
  const locale = useActiveLocale();
  return useMemo(() => {
    const ctx: FormatContext = { locale };
    return {
      money: (amountMinor, currency) => formatMoneyMinor(amountMinor, currency, ctx),
      number: (value, options) => formatNumber(value, ctx, options),
      day: (iso, options) => (options ? formatDay(iso, ctx, options) : formatDay(iso, ctx)),
      dateTime: (iso, options) =>
        options ? formatDateTime(iso, ctx, options) : formatDateTime(iso, ctx),
    };
  }, [locale]);
}
