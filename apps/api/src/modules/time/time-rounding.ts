/**
 * 52-01 — how a timed span becomes billed minutes.
 *
 * The organization picks an increment in Settings → Finance (`org_finance_profiles.rounding_minutes`,
 * 52-23). A span is first counted in whole minutes (any started minute counts, at least one), then
 * rounded UP to the increment: with 15, 1 minute is 15 and 16 minutes are 30. `0` means no rounding
 * beyond the whole minute. An increment outside {@link ROUNDING_INCREMENTS} falls back to
 * {@link DEFAULT_ROUNDING_MINUTES}, so a bad stored value cannot produce odd entries.
 *
 * Pure: the API's timer stop and the worker's auto-stop (which restates it) use the same table.
 */

export const ROUNDING_INCREMENTS = [0, 1, 5, 6, 10, 15, 30] as const;
export const DEFAULT_ROUNDING_MINUTES = 15;
/** One entry never exceeds one day (the 0103 bound the manual form also keeps). */
export const MAX_ENTRY_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

/** The increment to use for a stored value: a known one, else the default. */
export function roundingIncrement(stored: number | null | undefined): number {
  return typeof stored === 'number' && (ROUNDING_INCREMENTS as readonly number[]).includes(stored)
    ? stored
    : DEFAULT_ROUNDING_MINUTES;
}

/** Whole minutes in a span: any started minute counts, never less than one. */
export function spanMinutes(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  return Math.max(1, Math.ceil(elapsedMs / MINUTE_MS));
}

/** Round whole minutes up to the organization's increment, capped at one day. */
export function roundMinutes(minutes: number, stored: number | null | undefined): number {
  const whole = Math.max(1, Math.ceil(minutes));
  const step = roundingIncrement(stored);
  const rounded = step <= 1 ? whole : Math.ceil(whole / step) * step;
  return Math.min(rounded, MAX_ENTRY_MINUTES);
}

/** A span from start to end, rounded for the organization. */
export function roundedSpanMinutes(
  startedAt: Date,
  endedAt: Date,
  stored: number | null | undefined,
): number {
  return roundMinutes(spanMinutes(endedAt.getTime() - startedAt.getTime()), stored);
}
