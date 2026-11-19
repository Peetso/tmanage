'use client';

import { useMemo } from 'react';
import { formatRelative } from '../../lib/i18n/format';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { daysSince } from './overview-model';

/** ONEPAGE — the figures, amounts and dates of the one-page blocks, in the member's locale. */
export interface OverviewFormat {
  /** A count ("18"). */
  readonly count: (value: number) => string;
  /** Whole hours from minutes ("126"). */
  readonly hours: (minutes: number) => string;
  /** Major units from minor units, without the currency sign; the label names the currency. */
  readonly amount: (minor: number) => string;
  /** An amount with its currency ("AED 6,000.00"). */
  readonly money: (minor: number, currency: string) => string;
  /** A short calendar day ("28 Nov"). */
  readonly day: (iso: string) => string;
  /** How long ago, in days ("today", "2 days ago"). */
  readonly age: (iso: string) => string;
}

export function useOverviewFormat(now: Date): OverviewFormat {
  const locale = useActiveLocale();
  const display = useDisplayFormatters();
  return useMemo(
    () => ({
      count: (value) => display.number(value),
      hours: (minutes) => display.number(Math.round(minutes / 60)),
      amount: (minor) => display.number(minor / 100, { maximumFractionDigits: 2 }),
      money: (minor, currency) => display.money(minor, currency),
      day: (iso) => display.day(iso, { day: 'numeric', month: 'short' }),
      age: (iso) => formatRelative(-daysSince(iso, now), 'day', { locale }, { numeric: 'auto' }),
    }),
    [display, locale, now],
  );
}
