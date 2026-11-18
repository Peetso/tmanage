import type { ReactNode } from 'react';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { formatDay } from '../../lib/i18n/format';
import '../../styles/screens/portal.css';

/**
 * Small presentational pieces the client portal screens share (CL-01 … CL-13).
 *
 * Formatting only — nothing here fetches, decides visibility or invents a value. A field the
 * projection does not carry is simply not drawn.
 */

/** "Omar Adel" → "OA"; a single word gives its first two letters. */
export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function parse(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A calendar day (`2026-11-30`) is that day everywhere; an instant reads in the viewer's zone. */
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * SMALLFIX item 5. A portal date through the shared formatter in the member's locale (English in
 * the design's en-GB shape, Arabic with Latin digits), never a hand-built English string.
 */
function portalDay(
  value: string | Date | null | undefined,
  month: 'short' | 'long',
  locale: string | undefined,
): string {
  const parsed = parse(value);
  if (parsed === null) return typeof value === 'string' ? value : '';
  const bareDay = typeof value === 'string' && BARE_DAY.test(value);
  return formatDay(
    parsed.toISOString(),
    { locale: appDateLocale(locale) },
    { day: 'numeric', month, ...(bareDay ? { timeZone: 'UTC' } : {}) },
  );
}

/** "30 Sep" — the design's short date. Falls back to the raw value when it does not parse. */
export function shortDay(value: string | Date | null | undefined, locale?: string): string {
  return portalDay(value, 'short', locale);
}

/** "30 September". */
export function longDay(value: string | Date | null | undefined, locale?: string): string {
  return portalDay(value, 'long', locale);
}

/** Whole days from `now` to `value`, never negative. */
export function daysUntil(value: string | null, now: Date): number | null {
  const parsed = parse(value);
  if (parsed === null) return null;
  const ms = parsed.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function isPast(value: string | null, now: Date): boolean {
  const parsed = parse(value);
  return parsed !== null && parsed.getTime() < now.getTime();
}

/** A raw enum such as `in_review` or `on_track`, said in words: "In review", "On track". */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * A delivery-team person's project role in the client's language. It was `humanize(role)`, so the
 * Arabic portal named the team "Member" (TESTUX P0 3). An unknown role still reads in words.
 */
export function portalRoleLabel(
  role: string,
  tOr: (key: string, english: string) => string,
): string {
  return tOr(`PortalPeople.role.${role}`, humanize(role));
}

export function Avatar({
  name,
  tone = 'ink',
  size,
}: {
  name: string;
  tone?: 'ink' | 'soft' | 'client' | undefined;
  size?: 'md' | 'lg' | undefined;
}) {
  const classes = ['tm-pt-avatar'];
  if (tone !== 'ink') classes.push(`tm-pt-avatar--${tone}`);
  if (size) classes.push(`tm-pt-avatar--${size}`);
  return (
    <span className={classes.join(' ')} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Tag({
  tone,
  children,
}: {
  tone?: 'lime' | 'ink' | 'done' | 'warning' | 'client' | 'danger' | undefined;
  children: ReactNode;
}) {
  return <span className={tone ? `tm-pt-tag tm-pt-tag--${tone}` : 'tm-pt-tag'}>{children}</span>;
}

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
}

/** The pill switch at the end of a portal header ("Needs you · 3 / Waiting on the studio · 2"). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="tm-pt-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="tm-pt-seg__item"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
