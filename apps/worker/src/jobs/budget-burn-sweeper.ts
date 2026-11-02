import {
  burnOf,
  hasCapability,
  isBudgetType,
  parseAlertThresholds,
  thresholdsCrossed,
} from '@tmanage/domain';
import type { Burn } from '@tmanage/domain';
import type { InternalRecipientCandidate } from '../common/database/notifications-store.js';

/**
 * 52-05 (R16-b) — the budget burn sweep, every 15 minutes.
 *
 * Each pass takes up to {@link BUDGET_BURN_PASS_LIMIT} budgets, stalest cache first, across
 * organizations. Per budget, in one transaction under the budget row's lock: recompute the used
 * caches from `work_item_time_logs` (the same SUM the API runs on save), run the hysteresis
 * (`thresholdsCrossed`), and when a threshold is newly crossed record one `budget_alert_events` row
 * for the highest one, tell each project manager with one inbox notice (`budget.threshold`), write
 * `budget.alert_raised` and store the new `last_alert_bp`. The row lock makes two racing passes
 * serialise: the second reads the stored `last_alert_bp` and raises nothing (INT-52-12).
 *
 * The SQL lives in `common/database/budget-burn-store.ts`; this module is the seam above it.
 * 52-07 expenses are not read here yet (R16-c wires them), so `include_expenses` adds nothing.
 */

export const BUDGET_BURN_INTERVAL_MS = 15 * 60_000;
export const BUDGET_BURN_PASS_LIMIT = 200;
export const BUDGET_THRESHOLD_NOTICE = 'budget.threshold';

export interface BudgetToSweep {
  readonly organizationId: string;
  readonly projectId: string;
}

/** The locked budget row and the fresh SUM, as the store read them. */
export interface BudgetReading {
  readonly budgetType: string;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly alertThresholds: string;
  readonly lastAlertBp: number;
  readonly usedMinutes: number;
  readonly usedAmountMinor: number;
}

export interface BurnAlertDecision {
  readonly burn: Burn;
  /** The threshold (bp) to raise one alert for, or null. */
  readonly raiseBp: number | null;
  readonly lastAlertBp: number;
}

/** Pure: what one reading means — the burn, the alert to raise (highest crossed), the new memory. */
export function decideBurnAlert(reading: BudgetReading): BurnAlertDecision {
  const burn = burnOf({
    type: isBudgetType(reading.budgetType) ? reading.budgetType : 'hours',
    budgetMinutes: reading.budgetMinutes,
    budgetAmountMinor: reading.budgetAmountMinor,
    usedMinutes: reading.usedMinutes,
    usedAmountMinor: reading.usedAmountMinor,
  });
  const decision = thresholdsCrossed(
    parseAlertThresholds(reading.alertThresholds),
    reading.lastAlertBp,
    burn.percentBp,
  );
  const raiseBp =
    decision.crossed.length > 0 ? decision.crossed[decision.crossed.length - 1]! : null;
  return { burn, raiseBp, lastAlertBp: decision.lastAlertBp };
}

/**
 * Pure: who hears a budget alert — every active internal member who holds `project.manage` on this
 * project (org-wide scope, or a project membership), each once.
 */
export function budgetAlertRecipients(
  candidates: readonly InternalRecipientCandidate[],
): readonly string[] {
  const ids = candidates
    .filter(
      (c) =>
        c.role !== null &&
        (c.hasOrgWideScope || c.onProject) &&
        hasCapability(c.role, 'project.manage'),
    )
    .map((c) => c.userId);
  return [...new Set(ids)];
}

export interface BudgetBurnStore {
  /** Budgets with the stalest cache first, across organizations. */
  listBudgets(limit: number): Promise<readonly BudgetToSweep[]>;
  /** Refresh one budget and raise its alert, in one transaction; true when an alert was raised. */
  sweepBudget(budget: BudgetToSweep): Promise<boolean>;
}

export interface BudgetBurnSweepResult {
  readonly budgets: number;
  readonly alerts: number;
  readonly failed: number;
}

/** Run one pass. One budget's failure is counted and does not stop the others. */
export async function sweepBudgetBurn(
  store: BudgetBurnStore,
  onError: (error: unknown) => void = () => undefined,
): Promise<BudgetBurnSweepResult> {
  const budgets = await store.listBudgets(BUDGET_BURN_PASS_LIMIT);
  let alerts = 0;
  let failed = 0;
  for (const budget of budgets) {
    try {
      if (await store.sweepBudget(budget)) alerts += 1;
    } catch (error) {
      failed += 1;
      onError(error);
    }
  }
  return { budgets: budgets.length, alerts, failed };
}
