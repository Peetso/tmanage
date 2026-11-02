/**
 * 52-05 (R16-b) — budget burn, pure.
 *
 * Every figure is an integer: minutes, minor units, and basis points (`10000` bp = 100 %). The API,
 * the worker sweep and the portal projection all call these, so "62 % used, at risk" means the same
 * thing on every surface.
 */

export const BUDGET_TYPES = ['hours', 'money', 'both'] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

export function isBudgetType(value: unknown): value is BudgetType {
  return typeof value === 'string' && (BUDGET_TYPES as readonly string[]).includes(value);
}

export type BurnStatus = 'on_track' | 'at_risk' | 'over';

/** At or above this share used, the budget is "at risk". */
export const BURN_AT_RISK_BP = 8_500;
/** Hysteresis: a threshold re-arms only once usage falls below it by this much (5 %). */
export const BURN_REARM_GAP_BP = 500;
/** A spend against a zero budget reads as this — far past 100 %, still an `INT`. */
export const BURN_PERCENT_CAP_BP = 1_000_000;
/** The default alert thresholds in whole percent, ascending. */
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [70, 85, 95, 100];

export interface BurnInput {
  readonly type: BudgetType;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly usedMinutes: number;
  readonly usedAmountMinor: number;
}

export interface Burn {
  /** The share used in basis points — the larger of the two dimensions for `both`. */
  readonly percentBp: number;
  /** Null when effort is not budgeted. Negative is an overrun. */
  readonly remainingMinutes: number | null;
  /** Null when money is not budgeted. Negative is an overrun. */
  readonly remainingMinor: number | null;
  readonly status: BurnStatus;
}

function shareBp(budget: number | null, used: number): number | null {
  if (budget === null) return null;
  if (budget <= 0) return used > 0 ? BURN_PERCENT_CAP_BP : 0;
  return Math.min(Math.floor((used * 10_000) / budget), BURN_PERCENT_CAP_BP);
}

export function burnStatusOf(percentBp: number): BurnStatus {
  if (percentBp > 10_000) return 'over';
  if (percentBp >= BURN_AT_RISK_BP) return 'at_risk';
  return 'on_track';
}

export function burnOf(input: BurnInput): Burn {
  const hours = input.type === 'money' ? null : shareBp(input.budgetMinutes, input.usedMinutes);
  const money =
    input.type === 'hours' ? null : shareBp(input.budgetAmountMinor, input.usedAmountMinor);
  const percentBp = Math.max(hours ?? 0, money ?? 0);
  return {
    percentBp,
    remainingMinutes: input.budgetMinutes === null ? null : input.budgetMinutes - input.usedMinutes,
    remainingMinor:
      input.budgetAmountMinor === null ? null : input.budgetAmountMinor - input.usedAmountMinor,
    status: burnStatusOf(percentBp),
  };
}

/**
 * Parse the stored `alert_thresholds` (`'70,85,95,100'`). Anything malformed reads as the default
 * list, so a bad row never silences the alerts.
 */
export function parseAlertThresholds(stored: string | null | undefined): readonly number[] {
  if (typeof stored !== 'string') return DEFAULT_ALERT_THRESHOLDS;
  const parts = stored.split(',').map((part) => Number(part.trim()));
  return validAlertThresholds(parts) ? parts : DEFAULT_ALERT_THRESHOLDS;
}

/** One to four whole percents, 1..100, strictly ascending. */
export function validAlertThresholds(values: readonly unknown[]): values is readonly number[] {
  if (values.length < 1 || values.length > 4) return false;
  let previous = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
      return false;
    }
    if (value <= previous) return false;
    previous = value;
  }
  return true;
}

export interface ThresholdDecision {
  /** Thresholds (bp) newly crossed by this reading, ascending; empty when nothing to raise. */
  readonly crossed: readonly number[];
  /** The `last_alert_bp` to store after this reading. */
  readonly lastAlertBp: number;
}

/**
 * Which thresholds this reading crosses, with hysteresis. `lastAlertBp` is the highest threshold
 * already alerted. A threshold re-arms only once usage drops below it by {@link BURN_REARM_GAP_BP}
 * (a credit note or a deleted entry), so usage hovering at 70 % raises one alert, not one per sweep.
 */
export function thresholdsCrossed(
  thresholdsPercent: readonly number[],
  lastAlertBp: number,
  usedBp: number,
): ThresholdDecision {
  const ascending = [...thresholdsPercent].map((p) => p * 100).sort((a, b) => a - b);
  // Re-arm: keep only the alerted thresholds usage still sits within the gap of.
  let armedFrom = 0;
  for (const bp of ascending) {
    if (bp <= lastAlertBp && usedBp >= bp - BURN_REARM_GAP_BP) armedFrom = bp;
  }
  const crossed = ascending.filter((bp) => bp > armedFrom && bp <= usedBp);
  return { crossed, lastAlertBp: crossed.length > 0 ? crossed[crossed.length - 1]! : armedFrom };
}

/**
 * The day the budget runs out at the current weekly burn (`YYYY-MM-DD`), or null when nothing is
 * being burned. Already exhausted is today.
 */
export function forecastExhaustion(
  weeklyBurn: number,
  remaining: number,
  today: string,
): string | null {
  if (remaining <= 0) return today;
  if (!(weeklyBurn > 0)) return null;
  const days = Math.ceil((remaining / weeklyBurn) * 7);
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
