import { BURN_AT_RISK_BP, forecastExhaustion } from '@tmanage/domain';
import type { BurnBucket } from './api/project-budget-burn';

/**
 * 52-05 — the project overview's budget burn panel (Figma `574:32611`): the cumulative burn line,
 * the pace, the forecast finish and the over-budget state, computed from the burn report and the
 * budget summary. Pure, so the numbers are unit-tested without rendering.
 */

export interface BurnPoint {
  /** The week's Monday, `YYYY-MM-DD`. */
  readonly week: string;
  /** Minutes used on the project up to the end of this week. */
  readonly cumulativeMinutes: number;
}

/**
 * The burn line. The report covers only its range, so the line starts from whatever was used
 * before it: `usedMinutes` (the budget's cached total) minus the range's sum, never below zero.
 */
export function burnLine(
  buckets: readonly BurnBucket[],
  usedMinutes: number,
): readonly BurnPoint[] {
  const ordered = buckets.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const inRange = ordered.reduce((sum, bucket) => sum + bucket.minutes, 0);
  let running = Math.max(0, usedMinutes - inRange);
  return ordered.map((bucket) => {
    running += bucket.minutes;
    return { week: bucket.key, cumulativeMinutes: running };
  });
}

/** Average minutes per week over the range `from..to` (at least one week). */
export function weeklyPace(buckets: readonly BurnBucket[], from: string, to: string): number {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  const weeks = Math.max(1, (Number.isFinite(days) ? days : 7) / 7);
  return buckets.reduce((sum, bucket) => sum + bucket.minutes, 0) / weeks;
}

export type BurnState = 'no_budget' | 'on_track' | 'at_risk' | 'over';

export interface BurnForecast {
  readonly state: BurnState;
  /** Used share of the hours budget, whole percent (null without an hours budget). */
  readonly percent: number | null;
  /** Minutes over the budget (0 when within it). */
  readonly overMinutes: number;
  /** The day the hours budget runs out at the current pace; null with no pace or no budget. */
  readonly finishOn: string | null;
}

/**
 * The verdict the panel shows. `serverForecast` (the API's `forecastExhaustedOn`) wins when given;
 * otherwise the same domain rule runs here on the pace.
 */
export function forecastBurn(input: {
  readonly budgetMinutes: number | null;
  readonly usedMinutes: number;
  readonly weeklyMinutes: number;
  readonly today: string;
  readonly serverForecast?: string | null;
}): BurnForecast {
  const { budgetMinutes, usedMinutes } = input;
  if (budgetMinutes === null || budgetMinutes < 0) {
    return { state: 'no_budget', percent: null, overMinutes: 0, finishOn: null };
  }
  const remaining = budgetMinutes - usedMinutes;
  const percent =
    budgetMinutes === 0
      ? usedMinutes > 0
        ? 100
        : 0
      : Math.round((usedMinutes / budgetMinutes) * 100);
  const basisPoints = budgetMinutes === 0 ? (usedMinutes > 0 ? 10_000 : 0) : percent * 100;
  const state: BurnState =
    remaining < 0 ? 'over' : basisPoints >= BURN_AT_RISK_BP ? 'at_risk' : 'on_track';
  const finishOn =
    input.serverForecast !== undefined && input.serverForecast !== null
      ? input.serverForecast
      : forecastExhaustion(input.weeklyMinutes, remaining, input.today);
  return { state, percent, overMinutes: Math.max(0, -remaining), finishOn };
}

/** Hours with at most one decimal (`126`, `7.5`); the unit comes from the message catalog. */
export function hoursValue(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}
