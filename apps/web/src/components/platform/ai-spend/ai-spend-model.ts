import { MICRO_USD_PER_CENT } from '../../../lib/api/ai-spend';
import type {
  AiAdminPool,
  AiBudgetPoolView,
  AiBudgetView,
  AiPoolClass,
} from '../../../lib/api/ai-spend';
import { parseTypedAmount } from '../../ai-chat/ai-chat-model';

/**
 * AI spend's functional core (IP-3): pool rows, totals, the ceiling check and dollar input. Pure;
 * every figure comes from `GET …/ai-budget` and the server checks the ceiling again (AR-9).
 */

/** A pool not used yet this month has no row: it is its cap, untouched. */
export function poolRow(view: AiBudgetView, pool: AiAdminPool): AiBudgetPoolView {
  return (
    view.pools.find((row) => row.pool === pool) ?? {
      pool,
      capMicroUsd: view.capsMicroUsd[pool],
      settledMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: view.capsMicroUsd[pool],
      paused: view.paused,
      pausedReason: view.paused ? 'admin' : null,
    }
  );
}

/** Paused by its cap (lowered below what it spent, or reached), not by "Pause AI". */
export function overCap(row: AiBudgetPoolView): boolean {
  return row.paused && row.pausedReason !== 'admin';
}

export function monthTotals(view: AiBudgetView): { spent: number; held: number } {
  let spent = 0;
  let held = 0;
  for (const row of view.pools) {
    spent += row.settledMicroUsd;
    held += row.reservedMicroUsd;
  }
  return { spent, held };
}

/** What the three caps add up to when `pool` takes `microUsd`. */
export function capsTotalWith(view: AiBudgetView, pool: AiAdminPool, microUsd: number): number {
  let total = 0;
  for (const name of ['customers', 'testing', 'reserve'] as const) {
    total += name === pool ? microUsd : view.capsMicroUsd[name];
  }
  return total;
}

export function centsOf(microUsd: number): number {
  return Math.round(microUsd / MICRO_USD_PER_CENT);
}

/** A typed dollar amount ("$250", "250.5", Arabic-Indic digits) in whole cents, or null. */
export function dollarsToCents(raw: string): number | null {
  const amount = parseTypedAmount(raw.replace(/[$\s]/gu, ''));
  if (amount === null || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(cents - amount * 100) < 1e-6 ? cents : null;
}

/** "$412" for whole dollars, "$412.50" otherwise; Latin digits in every locale (LTR money). */
export function usd(microUsd: number, locale: string): string {
  const dollars = microUsd / (MICRO_USD_PER_CENT * 100);
  const whole = Number.isInteger(dollars);
  return new Intl.NumberFormat(locale.startsWith('ar') ? 'ar-u-nu-latn' : locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(dollars);
}

/** Share of `part` in `whole`, as a whole percent (0 when the whole is 0). */
export function percent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

/** Pack sizes offered in "Grant credits", within the API's `maxPackCredits`. */
export function packSizes(maxPackCredits: number): number[] {
  const sizes = [1000, 2500, 5000, 10000].filter((size) => size <= maxPackCredits);
  return sizes.length > 0 ? sizes : [maxPackCredits];
}

export const POOL_CLASSES: readonly AiPoolClass[] = ['customers', 'testing'];

/**
 * The reserve release needs a step-up confirmed in the last 15 minutes. The step-up started at
 * its expiry minus the window; `null` (no step-up) is never fresh.
 */
export function stepUpFresh(
  expiresAt: string | null,
  windowMinutes: number,
  now: Date,
  freshMinutes = 15,
): boolean {
  if (expiresAt === null) return false;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry) || expiry <= now.getTime()) return false;
  const confirmedAt = expiry - windowMinutes * 60_000;
  return now.getTime() - confirmedAt <= freshMinutes * 60_000;
}
