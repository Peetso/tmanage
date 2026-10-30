/**
 * 52-01 (0265): the forgotten-timer auto-stop.
 *
 * A member who starts a timer and walks away should not wake up to a 40-hour entry. Every running
 * timer (`time_timers`) older than its organization's limit — `org_policies.policy_json`
 * `time_autostop_hours`, 4..24, default 12 — is stopped AT the limit (not at "now"), filed as one
 * `work_item_time_logs` entry with `source = 'timer'` and `needs_review = 1` so the person checks
 * it, and recorded as `time_timer.auto_stopped` in the organization's audit log (ids only, no
 * actor: the system did it).
 *
 * Idempotent: each timer is deleted first in its own transaction and only a delete that removed
 * the row files the entry, so a retry, a second worker or a member who stopped it a moment earlier
 * never yields a second entry. The worker does not import the API, so the rounding rule
 * (`modules/time/time-rounding.ts`) and the policy reading (`time-rules.ts`) are restated here;
 * their tables are the same.
 *
 * The SQL lives in `common/database/timer-autostop-store.ts` (raw SQL is confined to database
 * modules); this file is the seam above it, unit-tested against a fake store.
 *
 * Grants (`tmanage_worker`): SELECT + DELETE on `time_timers`, SELECT on `org_policies` and
 * `org_finance_profiles`, INSERT on `work_item_time_logs`; SELECT on `work_items` and INSERT on
 * `audit_events` it already holds.
 */

/** The most timers one pass stops; the next pass takes the rest. */
export const AUTOSTOP_BATCH = 200;
/** Loop mode runs the pass this often. */
export const AUTOSTOP_INTERVAL_MS = 5 * 60_000;

export const AUTOSTOP_MIN_HOURS = 4;
export const AUTOSTOP_MAX_HOURS = 24;
export const AUTOSTOP_DEFAULT_HOURS = 12;
const HOUR_MS = 60 * 60_000;
const ROUNDING_INCREMENTS: readonly number[] = [0, 1, 5, 6, 10, 15, 30];
const DEFAULT_ROUNDING = 15;
const MAX_ENTRY_MINUTES = 24 * 60;

/** One running timer old enough to be looked at, with its organization's settings. */
export interface RunningTimer {
  readonly id: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
  readonly billable: boolean;
  readonly startedAt: Date;
  /** `org_policies.policy_json` as the driver returned it (object or text), or null. */
  readonly policy: unknown;
  /** `org_finance_profiles.rounding_minutes`, or null before the first finance save. */
  readonly roundingMinutes: number | null;
}

/** The entry an auto-stop files. */
export interface AutostopEntry {
  readonly endedAt: Date;
  readonly minutes: number;
  readonly spentOn: string;
  readonly source: 'timer';
  /** Always true: a stopped-for-you entry asks the person to check it. */
  readonly needsReview: true;
  /** The limit that applied, for the audit row. */
  readonly autostopHours: number;
}

/** The statements the sweep needs. Faked by the unit test. */
export interface TimerAutostopStore {
  /** Timers started at or before `startedBefore`, oldest first. */
  listCandidates(startedBefore: Date, limit: number): Promise<readonly RunningTimer[]>;
  /** In ONE transaction: delete the timer; only if that removed it, file the entry and audit. */
  autostop(timer: RunningTimer, entry: AutostopEntry): Promise<boolean>;
}

export interface AutostopResult {
  readonly stopped: number;
  readonly skipped: number;
}

/** `time_autostop_hours` from a stored policy document; anything off-range is the default. */
export function autostopHours(policy: unknown): number {
  let doc: unknown = policy;
  if (typeof policy === 'string') {
    try {
      doc = JSON.parse(policy);
    } catch {
      return AUTOSTOP_DEFAULT_HOURS;
    }
  }
  const hours =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>)['time_autostop_hours']
      : undefined;
  return typeof hours === 'number' &&
    Number.isInteger(hours) &&
    hours >= AUTOSTOP_MIN_HOURS &&
    hours <= AUTOSTOP_MAX_HOURS
    ? hours
    : AUTOSTOP_DEFAULT_HOURS;
}

/** Whole minutes (any started minute, at least one), rounded up to the increment, max a day. */
export function autostopMinutes(elapsedMs: number, rounding: number | null): number {
  const whole = Math.max(1, Math.ceil(Math.max(0, elapsedMs) / 60_000));
  const step =
    rounding !== null && ROUNDING_INCREMENTS.includes(rounding) ? rounding : DEFAULT_ROUNDING;
  return Math.min(step <= 1 ? whole : Math.ceil(whole / step) * step, MAX_ENTRY_MINUTES);
}

/** The entry for a timer at `now`, or null when it is still inside its organization's limit. */
export function autostopEntryFor(timer: RunningTimer, now: Date): AutostopEntry | null {
  const hours = autostopHours(timer.policy);
  const endedAt = new Date(timer.startedAt.getTime() + hours * HOUR_MS);
  if (endedAt.getTime() > now.getTime()) return null;
  return {
    endedAt,
    minutes: autostopMinutes(endedAt.getTime() - timer.startedAt.getTime(), timer.roundingMinutes),
    spentOn: timer.startedAt.toISOString().slice(0, 10),
    source: 'timer',
    needsReview: true,
    autostopHours: hours,
  };
}

/** One pass. Candidates are read with the smallest limit (4 h); each is judged by its own. */
export async function sweepForgottenTimers(
  store: TimerAutostopStore,
  now: Date,
  limit = AUTOSTOP_BATCH,
): Promise<AutostopResult> {
  const candidates = await store.listCandidates(
    new Date(now.getTime() - AUTOSTOP_MIN_HOURS * HOUR_MS),
    limit,
  );
  let stopped = 0;
  let skipped = 0;
  for (const timer of candidates) {
    const entry = autostopEntryFor(timer, now);
    if (entry === null || !(await store.autostop(timer, entry))) {
      skipped += 1;
      continue;
    }
    stopped += 1;
  }
  return { stopped, skipped };
}

/**
 * Loop mode: one pass now and one every {@link AUTOSTOP_INTERVAL_MS} until the signal aborts. A
 * failed pass is logged and the next one tries again; it never ends the process. The store is
 * `createTimerAutostopStore(database)` (`common/database/timer-autostop-store.ts`, the only place
 * its SQL may live).
 */
export async function runTimerAutostopLoop(
  store: TimerAutostopStore,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) => {
    console.error('[worker] timer auto-stop failed', error);
  },
  intervalMs = AUTOSTOP_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await sweepForgottenTimers(store, new Date());
      if (result.stopped > 0) {
        console.warn(`[worker] timers: auto-stopped ${String(result.stopped)} forgotten timer(s)`);
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
