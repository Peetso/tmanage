/**
 * 52-06 (R17-d) — the retainer period roll, every hour.
 *
 * Each pass, across organizations:
 *
 * 1. **Roll.** Up to {@link RETAINER_ROLL_PASS_LIMIT} open periods whose `period_end` may already
 *    be behind (a superset read on UTC; the store re-checks "today" in the organization's own time
 *    zone, so Riyadh's 23:30 on the last day is still that day). Per period, in one transaction
 *    under the retainer row's lock: close it (the used / overage caches = the API's SUM, frozen from
 *    here on — a period inside a 52-03 lock is closed with that same frozen figure and never
 *    recomputed), compute the rollover, open the next period (a duplicate key means another pass
 *    already opened it: skip), audit `retainer.period_closed` and tell the retainer's creator with
 *    one inbox notice. A paused retainer does not roll; an ended one closes its last period and opens
 *    nothing, as does one whose next period would start after `ends_on`.
 * 2. **Refresh.** Up to {@link RETAINER_ROLL_PASS_LIMIT} open periods get `used_minutes_cache`
 *    recomputed (a cursor walks them, so more than one pass's worth all get their turn).
 *
 * The SQL lives in `common/database/retainer-store.ts`. The period maths mirrors the API's
 * `modules/finance/retainers-rules.ts` (this app cannot import it); UNIT-52-09 pins both.
 */

export const RETAINER_ROLL_INTERVAL_MS = 60 * 60_000;
export const RETAINER_ROLL_PASS_LIMIT = 200;
export const RETAINER_PERIOD_CLOSED_NOTICE = 'retainer.period_closed';

export type RetainerPeriodKind = 'monthly' | 'quarterly';
export type RetainerRolloverRule = 'none' | 'cap' | 'unlimited';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): { y: number; m: number; d: number } {
  const match = DAY.exec(day);
  if (match === null) throw new Error(`not an ISO day: ${day}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function anchoredStart(startsOn: string, offsetMonths: number): string {
  const { y, m, d } = parts(startsOn);
  const total = y * 12 + (m - 1) + offsetMonths;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return iso(year, month, Math.min(d, new Date(Date.UTC(year, month, 0)).getUTCDate()));
}

function addDays(day: string, days: number): string {
  const { y, m, d } = parts(day);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return iso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** The `index`-th period of a retainer that starts on `startsOn` (as the API computes it). */
export function retainerPeriodBounds(
  startsOn: string,
  period: RetainerPeriodKind,
  index: number,
): { readonly periodStart: string; readonly periodEnd: string } {
  const step = period === 'quarterly' ? 3 : 1;
  return {
    periodStart: anchoredStart(startsOn, index * step),
    periodEnd: addDays(anchoredStart(startsOn, (index + 1) * step), -1),
  };
}

/** The period that follows the one starting on `periodStart`. */
export function nextRetainerPeriod(
  startsOn: string,
  period: RetainerPeriodKind,
  periodStart: string,
): { readonly periodStart: string; readonly periodEnd: string } {
  const from = parts(startsOn);
  const at = parts(periodStart);
  const step = period === 'quarterly' ? 3 : 1;
  let index = Math.max(0, Math.round(((at.y - from.y) * 12 + (at.m - from.m)) / step));
  // Clamping can shift a start by days, never by a whole period; settle on the exact match.
  while (retainerPeriodBounds(startsOn, period, index).periodStart > periodStart) index -= 1;
  while (retainerPeriodBounds(startsOn, period, index).periodStart < periodStart) index += 1;
  return retainerPeriodBounds(startsOn, period, index + 1);
}

/** What carries into the next period (as the API's `rolloverIn`). */
export function retainerRolloverIn(
  previousRemainingMinutes: number,
  rule: string,
  capMinutes: number | null,
): number {
  const remaining = Math.max(0, Math.trunc(previousRemainingMinutes));
  if (rule === 'unlimited') return remaining;
  if (rule === 'cap') return Math.min(remaining, Math.max(0, capMinutes ?? 0));
  return 0;
}

/** The locked retainer and its open period, as the store read them. */
export interface RetainerRollReading {
  readonly state: string;
  readonly period: RetainerPeriodKind;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly hoursPerPeriod: number | null;
  readonly rollover: string;
  readonly rolloverCapMinutes: number | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly allowanceMinutes: number;
  readonly rolloverInMinutes: number;
  readonly usedMinutes: number;
  /** Today in the organization's time zone. */
  readonly today: string;
}

export interface RetainerRollDecision {
  readonly close: boolean;
  readonly overageMinutes: number;
  /** The next period to open, or null (paused, ended, past `ends_on`, or not due). */
  readonly next: {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly allowanceMinutes: number;
    readonly rolloverInMinutes: number;
  } | null;
}

/** Pure: whether a period is due to close, and what opens after it. */
export function decideRetainerRoll(reading: RetainerRollReading): RetainerRollDecision {
  const offered = reading.allowanceMinutes + reading.rolloverInMinutes;
  const overageMinutes = Math.max(0, reading.usedMinutes - offered);
  const due = reading.periodEnd < reading.today && reading.state !== 'paused';
  if (!due) return { close: false, overageMinutes, next: null };
  const bounds = nextRetainerPeriod(reading.startsOn, reading.period, reading.periodStart);
  const opens =
    reading.state === 'active' && (reading.endsOn === null || bounds.periodStart <= reading.endsOn);
  return {
    close: true,
    overageMinutes,
    next: opens
      ? {
          ...bounds,
          allowanceMinutes:
            reading.hoursPerPeriod === null ? 0 : Math.max(0, reading.hoursPerPeriod) * 60,
          rolloverInMinutes: retainerRolloverIn(
            offered - reading.usedMinutes,
            reading.rollover,
            reading.rolloverCapMinutes,
          ),
        }
      : null,
  };
}

export interface OpenRetainerPeriod {
  readonly organizationId: string;
  readonly retainerId: string;
  readonly periodId: string;
}

export interface RetainerStore {
  /** Open periods that may be due (period_end before tomorrow in UTC), across organizations. */
  listDue(limit: number): Promise<readonly OpenRetainerPeriod[]>;
  /** Close one period and open the next, in one transaction; true when it closed. */
  rollPeriod(period: OpenRetainerPeriod): Promise<boolean>;
  /** Open periods after `cursor` (by period id), for the cache refresh. */
  listOpen(after: string | null, limit: number): Promise<readonly OpenRetainerPeriod[]>;
  /** Recompute one open period's `used_minutes_cache`. */
  refreshPeriod(period: OpenRetainerPeriod): Promise<void>;
}

export interface RetainerRollResult {
  readonly closed: number;
  readonly refreshed: number;
  readonly failed: number;
}

/** Where the refresh walk resumes; shared by passes in one process. */
export interface RetainerRollState {
  refreshAfter: string | null;
}

const PROCESS_STATE: RetainerRollState = { refreshAfter: null };

/** Run one pass. One retainer's failure is counted and does not stop the others. */
export async function sweepRetainerPeriods(
  store: RetainerStore,
  onError: (error: unknown) => void = () => undefined,
  state: RetainerRollState = PROCESS_STATE,
): Promise<RetainerRollResult> {
  let closed = 0;
  let refreshed = 0;
  let failed = 0;
  for (const period of await store.listDue(RETAINER_ROLL_PASS_LIMIT)) {
    try {
      if (await store.rollPeriod(period)) closed += 1;
    } catch (error) {
      failed += 1;
      onError(error);
    }
  }
  const open = await store.listOpen(state.refreshAfter, RETAINER_ROLL_PASS_LIMIT);
  state.refreshAfter = open.length < RETAINER_ROLL_PASS_LIMIT ? null : open.at(-1)!.periodId;
  for (const period of open) {
    try {
      await store.refreshPeriod(period);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      onError(error);
    }
  }
  return { closed, refreshed, failed };
}
