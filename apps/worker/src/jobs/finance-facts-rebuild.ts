/**
 * 52-14 (R17-a) — the nightly finance facts rebuild (migration 0296, `finance_daily_facts`).
 *
 * Nightly at 02:30 UTC, and on boot when the newest `computed_at` is older than 26 hours (the
 * `growth-rollup.ts` loop pattern), every organization with time, expenses or facts in the window
 * has its last 90 days recomputed: DELETE of the window, INSERT from the sources, one transaction
 * per organization so one bad tenant never blocks the rest. The rebuild is a pure function of the
 * sources, so a rerun writes the same rows. This file holds no SQL;
 * `common/database/finance-facts-store.ts` does (copied from the API's
 * `finance-reports.repository.ts`). A loop, not a `scheduled-sweeps.mjs` entry.
 */
import { FINANCE_FACTS_WINDOW_DAYS } from '@tmanage/domain';

export const FINANCE_FACTS_RUN_HOUR_UTC = 2;
export const FINANCE_FACTS_RUN_MINUTE_UTC = 30;
export const FINANCE_FACTS_STALE_MS = 26 * 60 * 60 * 1000;
export const FINANCE_FACTS_TICK_MS = 15 * 60 * 1000;

const DAY_MS = 86_400_000;

export interface FinanceFactsStore {
  /** The newest `computed_at` across every organization, or `null` when the table is empty. */
  lastComputedAt(): Promise<Date | null>;
  /** Organizations with time logs, expenses or facts dated within `[from, to]`. */
  organizations(from: string, to: string): Promise<readonly string[]>;
  /** One organization's window, in its own transaction. Returns the rows written. */
  rebuild(organizationId: string, from: string, to: string, computedAt: Date): Promise<number>;
}

export interface FinanceFactsDeps {
  readonly store: FinanceFactsStore;
  readonly now?: () => Date;
}

export interface FinanceFactsResult {
  readonly organizations: number;
  readonly rows: number;
  readonly failed: number;
}

const iso = (at: Date): string => at.toISOString().slice(0, 10);

/** The 90-day window ending today (UTC), both ends inclusive. */
export function financeFactsWindow(now: Date): { readonly from: string; readonly to: string } {
  const to = iso(now);
  const from = iso(
    new Date(Date.parse(`${to}T00:00:00Z`) - (FINANCE_FACTS_WINDOW_DAYS - 1) * DAY_MS),
  );
  return { from, to };
}

/** Due when never run, when the last run is over 26 h old, or once past tonight's 02:30 UTC. */
export function financeFactsDue(last: Date | null, now: Date): boolean {
  if (last === null) return true;
  if (now.getTime() - last.getTime() > FINANCE_FACTS_STALE_MS) return true;
  const tonight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    FINANCE_FACTS_RUN_HOUR_UTC,
    FINANCE_FACTS_RUN_MINUTE_UTC,
  );
  return last.getTime() < tonight && now.getTime() >= tonight;
}

export async function runFinanceFactsRebuild(
  deps: FinanceFactsDeps,
  onError: (organizationId: string, error: unknown) => void = (organizationId, error) =>
    console.error(`[worker] finance facts rebuild failed for ${organizationId}`, error),
): Promise<FinanceFactsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const window = financeFactsWindow(now);
  const organizations = await deps.store.organizations(window.from, window.to);
  let rows = 0;
  let failed = 0;
  for (const organizationId of organizations) {
    try {
      rows += await deps.store.rebuild(organizationId, window.from, window.to, now);
    } catch (error) {
      failed += 1;
      onError(organizationId, error);
    }
  }
  return { organizations: organizations.length, rows, failed };
}
