'use client';

import { useMemo } from 'react';
import type { MessageKey } from '../../lib/i18n/t';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';

/** Every key the TManage AI screens draw (plan 62, slices 62-15…62-19 and Business Memory). */
export type AiTextKey = Extract<
  MessageKey,
  `AiChat.${string}` | `AiUsage.${string}` | `AiSpend.${string}` | `BusinessMemory.${string}`
>;

/** `{name}` placeholders filled from `values`; a missing value leaves the placeholder. */
export function fillText(template: string, values?: Readonly<Record<string, string | number>>) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

export interface AiText {
  readonly t: (key: AiTextKey, values?: Readonly<Record<string, string | number>>) => string;
  /** "1 credit", "40 credits" in the locale's plural form and digits. */
  readonly credits: (count: number) => string;
  /** Any `{base}.one/.other/...` phrase of these screens, `{count}` in the locale's digits. */
  readonly plural: (
    base: string,
    count: number,
    english: { readonly one: string; readonly other: string },
  ) => string;
  readonly number: (value: number) => string;
  readonly time: (iso: string) => string;
  readonly day: (iso: string) => string;
  readonly locale: string;
}

export function useAiText(): AiText {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const format = useDisplayFormatters();
  return useMemo(
    () => ({
      t: (key, values) => fillText(t(key), values),
      credits: (count) =>
        pluralPhrase(
          tOr,
          locale,
          'AiChat.credits',
          count,
          { one: '{count} credit', other: '{count} credits' },
          format.number(count),
        ),
      plural: (base, count, english) =>
        pluralPhrase(tOr, locale, base, count, english, format.number(count)),
      number: (value) => format.number(value),
      time: (iso) => format.time(iso),
      day: (iso) => format.day(iso, { day: 'numeric', month: 'short' }),
      locale,
    }),
    [t, tOr, locale, format],
  );
}
