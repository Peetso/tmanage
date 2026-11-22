'use client';

import { useMemo } from 'react';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { dayGap } from './attack-tracker-model';

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

export interface TrackerFormat {
  readonly locale: string;
  /** "11:42", in the reader's zone and digits. */
  time(iso: string): string;
  /** "22 Nov". */
  day(iso: string): string;
  /** "22 Nov 11:35". */
  dayTime(iso: string): string;
  /** The list's Last seen: the time today, "Yesterday", else the day. */
  lastSeen(iso: string, now: Date): string;
  /** A count in the locale's digits and grouping. */
  count(value: number): string;
}

/** The tracker's dates and numbers (Figma: 24-hour times, short day; R4: the reader's zone). */
export function useTrackerFormat(): TrackerFormat {
  const locale = useActiveLocale();
  const format = useDisplayFormatters();
  const t = useT();
  return useMemo(() => {
    const time = (iso: string) => format.time(iso, CLOCK);
    const day = (iso: string) => format.day(iso, DAY);
    return {
      locale,
      time,
      day,
      dayTime: (iso: string) => `${day(iso)} ${time(iso)}`,
      lastSeen: (iso: string, now: Date) => {
        const gap = dayGap(iso, now);
        if (gap <= 0) return time(iso);
        if (gap === 1) return t('AttackTracker.yesterday');
        return day(iso);
      },
      count: (value: number) => format.number(value),
    };
  }, [format, locale, t]);
}
