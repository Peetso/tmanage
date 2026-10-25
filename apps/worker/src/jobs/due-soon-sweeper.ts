import type { AutomationRule } from '../common/database/collaboration-store.js';

/**
 * C1 (AUT-03): the "work item due in N days" automation trigger.
 *
 * Nothing *happens* when a due date comes closer, so no outbox event can fire this trigger. A
 * sweep does instead, on the same shape as the defer and invitation sweeps: every enabled,
 * undeleted rule with trigger `work_item_due_soon` looks at its organization's open work items
 * (not `done`, not `archived`, not deleted) whose `due_at` is between now and the end of the day
 * `dueInDays` days from today (database clock, default 2). For each item the rule's conditions
 * are checked, then one `(rule, item, day)` claim is inserted into `workflow_due_soon_fires`; only
 * a new claim runs the rule (the same runner, recipients, weekend hold and run row as a rule
 * firing on an event). A second sweep on the same day claims nothing, so the trigger is idempotent
 * per item per day.
 *
 * The SQL lives in `common/database/due-soon-store.ts`; this module is the seam above it.
 */

export const DUE_SOON_TRIGGER = 'work_item_due_soon';

/** "Due in 2 days" unless the rule says otherwise (`config.dueInDays`, 1–30). */
export const DEFAULT_DUE_IN_DAYS = 2;
export const MAX_DUE_IN_DAYS = 30;

/** A due-soon rule as the sweep reads it, across tenants. */
export interface DueSoonRule extends AutomationRule {
  readonly organizationId: string;
  readonly dueInDays: number;
}

export interface DueSoonSweepStore {
  /** Every enabled, undeleted `work_item_due_soon` rule, in organization then id order. */
  listRules(): Promise<readonly DueSoonRule[]>;
  /** Fire one rule for its due items in one transaction; returns how many items it ran for. */
  fireRule(rule: DueSoonRule): Promise<number>;
}

export interface DueSoonSweepResult {
  readonly rules: number;
  readonly fired: number;
}

/**
 * The rule's window in days. A whole number from 1 to {@link MAX_DUE_IN_DAYS}; anything else —
 * absent, a string, a fraction, out of range — is the default, so a bad config never widens the
 * window past a month or makes it vanish.
 */
export function dueInDaysOf(config: Readonly<Record<string, unknown>>): number {
  const raw = config['dueInDays'];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_DUE_IN_DAYS) {
    return raw;
  }
  return DEFAULT_DUE_IN_DAYS;
}

/** Run one sweep. Idempotent per item per rule per day (the claim's unique key). */
export async function sweepDueSoon(store: DueSoonSweepStore): Promise<DueSoonSweepResult> {
  const rules = await store.listRules();
  let fired = 0;
  for (const rule of rules) fired += await store.fireRule(rule);
  return { rules: rules.length, fired };
}
