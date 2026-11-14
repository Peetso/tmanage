/**
 * 52-01 — how a manual timer's span becomes saved minutes. Shared so the API (which saves the
 * entry) and the web Stop dialog (which announces it) can never disagree.
 *
 * The company owner picks a step in the time settings (stored in
 * `org_finance_profiles.rounding_minutes`, default {@link DEFAULT_ROUNDING_MINUTES}). A span is
 * first counted in whole minutes (any started minute counts, at least one), then rounded UP to the
 * step: with 15, 1 minute is 15 and 16 minutes are 30. A step of `0` or `1` is "no rounding": the
 * exact whole minutes. A stored step outside {@link ROUNDING_INCREMENTS} falls back to the default,
 * so a bad stored value cannot produce odd entries.
 *
 * Automatic time is never rounded: it is filed minute for minute.
 */

export const ROUNDING_INCREMENTS = [0, 1, 5, 6, 10, 15, 30] as const;
export const DEFAULT_ROUNDING_MINUTES = 15;
/** The step that means "no rounding" when the owner chooses it (exact whole minutes). */
export const NO_ROUNDING_MINUTES = 1;
/** The steps the owner can choose in the time settings, "no rounding" first. */
export const TIME_ROUNDING_CHOICES = [NO_ROUNDING_MINUTES, 5, 6, 10, 15, 30] as const;
export type TimeRoundingChoice = (typeof TIME_ROUNDING_CHOICES)[number];
/** One entry never exceeds one day (the 0103 bound the manual form also keeps). */
export const MAX_ENTRY_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

export function isTimeRoundingChoice(value: unknown): value is TimeRoundingChoice {
  return (TIME_ROUNDING_CHOICES as readonly unknown[]).includes(value);
}

/** The step to use for a stored value: a known one, else the default. */
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

/** Round whole minutes up to the step, capped at one day. */
export function roundMinutes(minutes: number, stored: number | null | undefined): number {
  const whole = Math.max(1, Math.ceil(minutes));
  const step = roundingIncrement(stored);
  const rounded = step <= 1 ? whole : Math.ceil(whole / step) * step;
  return Math.min(rounded, MAX_ENTRY_MINUTES);
}

/** A span from start to end, rounded to the step. */
export function roundedSpanMinutes(
  startedAt: Date,
  endedAt: Date,
  stored: number | null | undefined,
): number {
  return roundMinutes(spanMinutes(endedAt.getTime() - startedAt.getTime()), stored);
}
