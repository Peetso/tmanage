'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Combobox } from '@tmanage/ui';
import { useActiveLocale } from '../lib/i18n/use-active-locale';
import { useTOr } from '../lib/i18n/use-t-or';
import { timeZoneOptions } from '../lib/time-zones';

export interface TimeZoneSelectProps {
  label: ReactNode;
  /** The stored IANA zone. Always offered, whatever it is. */
  value: string;
  /** Called with the chosen zone. Never called with `''`: a time zone field is never empty. */
  onChange: (zone: string) => void;
  /** Help text; the search hint by default, `null` for none. */
  hint?: ReactNode | null;
  error?: ReactNode;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** The instant offsets are shown for (a meeting's date); now by default. */
  at?: Date;
  /** The input's `aria-label`, where the visible label alone is not enough. */
  'aria-label'?: string;
}

/**
 * The time zone picker — R9 (Figma "Settings · Time zone picker — every country, searchable",
 * node 456:21423). Every IANA zone, each read as "(GMT+2) Cairo, Egypt", filtered as the person
 * types a city, a country or an offset. It is the design system's `Combobox`, so it looks and
 * behaves like every other field; this only supplies the list and keeps the field from being
 * emptied.
 *
 * Clearing the text is how a person starts a new search, not a choice of "no time zone": the
 * cleared value is ignored and, on blur, the field shows the stored zone again (remounting the
 * combobox re-derives its text from `value`).
 */
export function TimeZoneSelect({
  label,
  value,
  onChange,
  hint,
  error,
  name,
  disabled,
  required,
  className,
  at,
  'aria-label': ariaLabel,
}: TimeZoneSelectProps) {
  const locale = useActiveLocale();
  const tOr = useTOr();
  const utcName = tOr('TimeZoneSelect.utc', 'Coordinated Universal Time');
  // Offsets move twice a year, not per render: one list per locale, value and day.
  const day =
    at === undefined || Number.isNaN(at.getTime()) ? new Date().toDateString() : at.toDateString();
  const options = useMemo(
    () => timeZoneOptions(value, { locale, utcName, at: new Date(day) }),
    [value, locale, utcName, day],
  );
  const [generation, setGeneration] = useState(0);
  const [cleared, setCleared] = useState(false);

  const shownHint =
    hint === null
      ? undefined
      : (hint ?? tOr('TimeZoneSelect.hint', 'Type a city, country or GMT offset.'));

  return (
    <Combobox
      key={generation}
      label={label}
      options={options}
      value={value}
      openOnFocus
      emptyLabel={tOr('TimeZoneSelect.noMatch', 'No time zone matches that.')}
      onValueChange={(zone) => {
        if (zone === '') {
          setCleared(true);
          return;
        }
        setCleared(false);
        onChange(zone);
      }}
      // Live test 2026-11-01: clicking the field put the caret inside "(GMT+0) Coordinated
      // Universal Time", so typing "Cairo" landed mid-label and matched nothing. Selecting the
      // whole label on focus makes the first keystroke start a fresh search. The select runs after
      // the click's mouseup, which would otherwise collapse the selection again.
      onFocus={(event) => {
        const input = event.currentTarget;
        window.setTimeout(() => input.select(), 0);
      }}
      onBlur={() => {
        if (cleared) {
          setCleared(false);
          setGeneration((count) => count + 1);
        }
      }}
      {...(shownHint === undefined ? {} : { hint: shownHint })}
      {...(error === undefined ? {} : { error })}
      {...(name === undefined ? {} : { name })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
    />
  );
}
