'use client';

import { useMemo } from 'react';
import { appDateLocale } from '../../../lib/i18n/app-locale';
import { formatDay, formatNumber, formatTime, type FormatContext } from '../../../lib/i18n/format';
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
  /** A count in the locale's grouping, Latin digits in Arabic unless the reader saved others. */
  count(value: number): string;
}

/**
 * The tracker's dates and numbers (Figma: 24-hour times, short day; R4: the reader's zone).
 *
 * Arabic keeps Latin digits ("11:42", "333", "22 نوفمبر") as Figma 840:906 and the rest of the
 * product write them, and English days read "22 Nov" (en-GB) as Figma 840:1578: {@link
 * appDateLocale} gives both (Arabic gets `-u-nu-latn`), and the shared formatters still put
 * a member's saved digits (Settings, Display) over it. The bare `useDisplayFormatters` would fall
 * back to the locale's own Arabic-Indic digits when nothing is saved.
 */
export function useTrackerFormat(): TrackerFormat {
  const locale = useActiveLocale();
  // Read only so the memo re-binds when the saved digits or date layout change.
  const saved = useDisplayFormatters();
  const t = useT();
  return useMemo(() => {
    const ctx: FormatContext = { locale: appDateLocale(locale) };
    const time = (iso: string) => formatTime(iso, ctx, CLOCK);
    const day = (iso: string) => formatDay(iso, ctx, DAY);
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
      count: (value: number) => formatNumber(value, ctx),
    };
    // `saved` is listed so the formatters re-read the saved digits after a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, locale, t]);
}
