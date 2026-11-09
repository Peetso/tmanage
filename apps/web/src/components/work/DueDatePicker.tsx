'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import type { MessageKey } from '../../lib/i18n/t';
import '../screens/work-core.css';

/**
 * A6's catalog lookup. The wave's keys arrive through `i18n-A6.*.json` and are merged into the
 * catalogs by the committer; until then `translate` falls back to the key, so the cast is only a
 * type bridge. `{name}` placeholders are filled from `vars`.
 */
export function useA6T(): (
  key: string,
  vars?: Readonly<Record<string, string | number>>,
) => string {
  const t = useT();
  return useCallback(
    (key: string, vars?: Readonly<Record<string, string | number>>) => {
      let text = t(key as MessageKey);
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [t],
  );
}

/** Arabic screens keep Latin digits, the way the Figma catalog writes them. */
function intlLocale(locale: string): string {
  return locale.toLowerCase().startsWith('ar') ? 'ar-u-nu-latn' : 'en-GB';
}

export function isArabic(locale: string): boolean {
  return locale.toLowerCase().startsWith('ar');
}

/** `YYYY-MM-DD` → a UTC midnight `Date`; `null` for anything else. */
export function parseDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The calendar day a stored instant or bare date falls on, `YYYY-MM-DD` (UTC). */
export function dayOf(value: string | null): string {
  if (value === null) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/** The reader's own calendar day for `now`, as `YYYY-MM-DD`. */
export function todayOf(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(day: string, days: number): string {
  const parsed = parseDay(day);
  if (parsed === null) return day;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function partsOf(day: string, locale: string, options: Intl.DateTimeFormatOptions) {
  const parsed = parseDay(day);
  if (parsed === null) return new Map<string, string>();
  const parts = new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: 'UTC' })
    .formatToParts(parsed)
    .filter((part) => part.type !== 'literal');
  return new Map(parts.map((part) => [part.type, part.value]));
}

/** "Mon 20 Oct" · "الاثنين 20 أكتوبر" — the chips' form. */
export function formatChipDay(day: string, locale: string): string {
  const parts = partsOf(day, locale, {
    weekday: isArabic(locale) ? 'long' : 'short',
    day: 'numeric',
    month: isArabic(locale) ? 'long' : 'short',
  });
  return [parts.get('weekday'), parts.get('day'), parts.get('month')].filter(Boolean).join(' ');
}

/** "28 Oct" · "28 أكتوبر" — the board's and the files' form. */
export function formatShortDay(day: string, locale: string): string {
  const parts = partsOf(day, locale, {
    day: 'numeric',
    month: isArabic(locale) ? 'long' : 'short',
  });
  return [parts.get('day'), parts.get('month')].filter(Boolean).join(' ');
}

function monthTitle(year: number, month: number, locale: string): string {
  const parts = new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .formatToParts(new Date(Date.UTC(year, month, 1)))
    .filter((part) => part.type !== 'literal');
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get('month') ?? ''} ${byType.get('year') ?? ''}`.trim();
}

/** Monday first: 2024-01-01 was a Monday. */
function weekdayHeads(locale: string): readonly string[] {
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: isArabic(locale) ? 'narrow' : 'short',
    timeZone: 'UTC',
  });
  return Array.from({ length: 7 }, (_, index) => {
    const label = format.format(new Date(Date.UTC(2024, 0, 1 + index)));
    return isArabic(locale) ? label : label.slice(0, 2);
  });
}

/**
 * Escape closes only the topmost of A6's layers — a date picker over the edit dialog closes on
 * its own, leaving the dialog open.
 */
const layers: symbol[] = [];

function useEscapeLayer(onClose: () => void): void {
  // The latest handler, read through a ref so the layer registers once, on mount: re-registering
  // on every render would reorder the stack.
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const layer = Symbol('layer');
    layers.push(layer);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && layers[layers.length - 1] === layer) latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      layers.splice(layers.indexOf(layer), 1);
    };
  }, []);
}

/**
 * The modal frame A6's dialogs share: a scrim, a paper sheet, Escape to close, and focus moved
 * into the sheet on open so a keyboard reader lands inside it.
 */
export function WorkDialogFrame({
  labelledBy,
  onClose,
  width = 560,
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly width?: number;
  readonly children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useEscapeLayer(onClose);
  useEffect(() => {
    sheet.current?.focus();
  }, []);
  return (
    <div className="tm-wk-dialog__scrim">
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="tm-wk-dialog"
        style={{ inlineSize: `min(${width}px, 100%)` }}
      >
        {children}
      </div>
    </div>
  );
}

export interface DueDatePickerProps {
  /** The heading: "Due date" or "Start date". */
  readonly heading: string;
  /** The day currently set, `YYYY-MM-DD`, or `''` for none. */
  readonly value: string;
  /** Injected in tests; the reader's clock otherwise. */
  readonly now?: Date;
  /** Days before this one are not offered (a due date before the start). */
  readonly min?: string;
  /** A chosen day, or `null` for "Clear date". */
  readonly onSet: (day: string | null) => void;
  readonly onClose: () => void;
}

/**
 * **Due date picker (A6, Figma fq7-due-date-picker).**
 *
 * Today / Tomorrow / Next Monday set the day at once; the month grid (Monday first) picks one,
 * with today ringed and the picked day in lime, and "Set <d Mon>" commits it. "Clear date"
 * removes the date. Escape and a click outside close it without a change.
 */
export function DueDatePicker({ heading, value, now, min, onSet, onClose }: DueDatePickerProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const today = useMemo(() => todayOf(now ?? new Date()), [now]);
  const [picked, setPicked] = useState(value);
  const anchor = parseDay(value) ?? parseDay(today) ?? new Date();
  const [view, setView] = useState({ year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() });

  useEscapeLayer(onClose);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [onClose]);

  // FIX4 item 6 (C2): the month grid was cut off at the bottom of the screen. The panel opens
  // upwards when there is more room above its field, and scrolls inside itself when neither side
  // has room for all of it.
  const [placement, setPlacement] = useState<{ side: 'below' | 'above'; max: number | null }>({
    side: 'below',
    max: null,
  });
  useLayoutEffect(() => {
    const place = () => {
      const node = panel.current;
      const field = node?.parentElement;
      if (!node || !field) return;
      const margin = 8;
      const gap = 8;
      const box = field.getBoundingClientRect();
      const height = node.scrollHeight;
      const below = window.innerHeight - box.bottom - gap - margin;
      const above = box.top - gap - margin;
      const side = height <= below || below >= above ? 'below' : 'above';
      const room = side === 'below' ? below : above;
      const max = height > room ? Math.max(room, 160) : null;
      setPlacement((current) =>
        current.side === side && current.max === max ? current : { side, max },
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [view.year, view.month]);

  const todayDate = parseDay(today);
  const daysToMonday = todayDate === null ? 7 : (8 - todayDate.getUTCDay()) % 7 || 7;
  const quick = [
    { key: 'today', label: t('DueDatePicker.today'), day: today, long: true },
    { key: 'tomorrow', label: t('DueDatePicker.tomorrow'), day: addDays(today, 1), long: true },
    {
      key: 'monday',
      label: t('DueDatePicker.nextMonday'),
      day: addDays(today, daysToMonday),
      long: false,
    },
  ];

  const first = new Date(Date.UTC(view.year, view.month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, index) =>
      new Date(Date.UTC(view.year, view.month, index + 1)).toISOString().slice(0, 10),
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, row) =>
    cells.slice(row * 7, row * 7 + 7),
  );

  function shift(delta: number) {
    setView((current) => {
      const next = new Date(Date.UTC(current.year, current.month + delta, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });
  }

  return (
    <div
      ref={panel}
      role="dialog"
      aria-labelledby={titleId}
      className="tm-wk-datepicker"
      data-testid="due-date-picker"
      data-side={placement.side}
      style={
        placement.max === null ? undefined : { maxBlockSize: placement.max, overflowY: 'auto' }
      }
    >
      <p id={titleId} className="tm-wk-datepicker__title">
        {heading}
      </p>
      <ul className="tm-wk-datepicker__quick">
        {quick.map((option) => (
          <li key={option.key}>
            <button type="button" onClick={() => onSet(option.day)}>
              {option.label} ·{' '}
              {option.long ? formatChipDay(option.day, locale) : formatShortDay(option.day, locale)}
            </button>
          </li>
        ))}
      </ul>

      <div className="tm-wk-datepicker__month">
        <button
          type="button"
          className="tm-wk-datepicker__step"
          aria-label={t('DueDatePicker.previousMonth')}
          onClick={() => shift(-1)}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span className="tm-wk-datepicker__month-name" aria-live="polite">
          {monthTitle(view.year, view.month, locale)}
        </span>
        <button
          type="button"
          className="tm-wk-datepicker__step"
          aria-label={t('DueDatePicker.nextMonth')}
          onClick={() => shift(1)}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <table className="tm-wk-datepicker__grid" role="grid">
        <thead>
          <tr>
            {weekdayHeads(locale).map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, row) => (
            <tr key={row}>
              {week.map((day, column) => (
                <td key={column}>
                  {day === null ? null : (
                    <button
                      type="button"
                      aria-label={formatChipDay(day, locale)}
                      aria-pressed={day === picked}
                      data-today={day === today}
                      disabled={min !== undefined && min !== '' && day < min}
                      onClick={() => setPicked(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tm-wk-datepicker__foot">
        <button type="button" className="tm-wk-datepicker__clear" onClick={() => onSet(null)}>
          {t('DueDatePicker.clear')}
        </button>
        <button
          type="button"
          className="tm-wk-pill-button"
          data-tone="ink"
          disabled={picked === ''}
          onClick={() => onSet(picked)}
        >
          {picked === ''
            ? t('DueDatePicker.set')
            : t('DueDatePicker.setDay', { day: formatShortDay(picked, locale) })}
        </button>
      </div>
    </div>
  );
}
