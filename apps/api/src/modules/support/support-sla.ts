import type { CatalogPlanId } from '../billing/plan-catalog.js';

/**
 * 57-10 — the SLA layer on 55-17's support threads: the policy (data), business-time arithmetic
 * and the clock. Pure: no database, no clock of its own (`now` is passed in), so the table tests in
 * `support-sla.test.ts` pin every rule.
 *
 * - **Targets are captured at opening** (`support_threads.sla_*`, 0352): a later plan change or a
 *   policy edit never moves an open clock (57 SUP-03).
 * - **First response** runs from opening to the first platform-authored message
 *   (`first_response_at`, written by the server on the platform reply only — SUP-05). It does not
 *   pause: answering is the team's promise whatever the status.
 * - **Resolution** runs from opening to `closed_at` and **pauses while the thread is `waiting`**
 *   (the team answered and waits on the customer). Paused business minutes accumulate in
 *   `sla_paused_minutes`; a pause in progress starts at `sla_paused_at`.
 * - Minutes are **business minutes**: Sun–Thu 09:00–18:00 in the timezone captured at opening,
 *   minus `SUPPORT_HOLIDAYS` (MENA packs plug in here when 53-02's are wired).
 */

export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_CATEGORIES = [
  'question',
  'problem',
  'billing',
  'account',
  'feature_request',
  'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export interface BusinessHours {
  /** 0 = Sunday … 6 = Saturday (the local calendar day). */
  readonly workDays: readonly number[];
  readonly openMinute: number;
  readonly closeMinute: number;
  /** Local dates (`YYYY-MM-DD`) with no business hours. */
  readonly holidays: ReadonlySet<string>;
}

/** The support team's published hours (57 §12): Sunday to Thursday, 09:00–18:00. */
export const SUPPORT_HOURS: BusinessHours = {
  workDays: [0, 1, 2, 3, 4],
  openMinute: 9 * 60,
  closeMinute: 18 * 60,
  holidays: new Set<string>(),
};

const DAY = 9 * 60;

/**
 * First-response targets per plan, in business minutes (57 §12's table). "Same business day" is
 * modelled as six business hours; Enterprise's contract target defaults to Business's until a
 * contract value exists.
 */
export const FIRST_RESPONSE_MINUTES: Readonly<Record<CatalogPlanId, number>> = {
  free: 2 * DAY,
  starter: DAY,
  studio: 6 * 60,
  business: 4 * 60,
  enterprise: 4 * 60,
};

/** Priority scales the plan's first-response target; resolution is per priority. */
export const PRIORITY_POLICY: Readonly<
  Record<
    SupportPriority,
    { readonly firstResponseFactor: number; readonly resolutionMinutes: number }
  >
> = {
  low: { firstResponseFactor: 1, resolutionMinutes: 10 * DAY },
  normal: { firstResponseFactor: 1, resolutionMinutes: 5 * DAY },
  high: { firstResponseFactor: 0.75, resolutionMinutes: 2 * DAY },
  urgent: { firstResponseFactor: 0.5, resolutionMinutes: DAY },
};

export interface SlaTargets {
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
}

export function slaTargets(plan: CatalogPlanId, priority: SupportPriority): SlaTargets {
  const policy = PRIORITY_POLICY[priority];
  return {
    firstResponseMinutes: Math.round(FIRST_RESPONSE_MINUTES[plan] * policy.firstResponseFactor),
    resolutionMinutes: policy.resolutionMinutes,
  };
}

/** The published table for `GET /v1/public/site/support-targets`: one source, this file. */
export function publishedTargets() {
  return {
    hours: { days: 'sun-thu', open: '09:00', close: '18:00' },
    plans: (Object.keys(FIRST_RESPONSE_MINUTES) as CatalogPlanId[]).map((plan) => ({
      plan,
      firstResponseBusinessMinutes: FIRST_RESPONSE_MINUTES[plan],
    })),
    priorities: SUPPORT_PRIORITIES.map((priority) => ({ priority, ...PRIORITY_POLICY[priority] })),
  };
}

// ── Business-time arithmetic ────────────────────────────────────────────────

const MINUTE = 60_000;
const MAX_DAYS = 3660;

export function validTimeZone(zone: string | null | undefined, fallback = 'Asia/Riyadh'): string {
  // `UTC` is the organizations column's default, i.e. "not set": the team's own zone applies.
  if (!zone || zone === 'UTC') return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(zone: string, at: number) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) parts[part.type] = Number(part.value);
  return {
    y: parts['year'] ?? 1970,
    m: parts['month'] ?? 1,
    d: parts['day'] ?? 1,
    minute: (parts['hour'] ?? 0) * 60 + (parts['minute'] ?? 0),
  };
}

/** The UTC instant of local `y-m-d` at `minute` past midnight in `zone`. */
function instantOf(zone: string, y: number, m: number, d: number, minute: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, minute);
  const offsetAt = (t: number) => {
    const w = wall(zone, t);
    return Date.UTC(w.y, w.m - 1, w.d, 0, w.minute) - Math.floor(t / MINUTE) * MINUTE;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Each business window `[open, close)` (UTC ms) from the local day containing `from`. */
function* windows(
  zone: string,
  from: number,
  hours: BusinessHours,
): Generator<readonly [number, number]> {
  const start = wall(zone, from);
  for (let i = 0; i < MAX_DAYS; i += 1) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!hours.workDays.includes(day.getUTCDay()) || hours.holidays.has(key)) continue;
    yield [
      instantOf(zone, y, m, d, hours.openMinute),
      instantOf(zone, y, m, d, hours.closeMinute),
    ] as const;
  }
}

/** Business minutes in `[from, to)`. */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  zone: string,
  hours: BusinessHours = SUPPORT_HOURS,
): number {
  const [a, b] = [from.getTime(), to.getTime()];
  if (b <= a) return 0;
  let total = 0;
  for (const [open, close] of windows(zone, a, hours)) {
    if (open >= b) break;
    total += Math.max(0, Math.min(close, b) - Math.max(open, a));
  }
  return Math.floor(total / MINUTE);
}

/** The instant `minutes` business minutes after `from`. */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  zone: string,
  hours: BusinessHours = SUPPORT_HOURS,
): Date {
  let left = minutes * MINUTE;
  const a = from.getTime();
  for (const [open, close] of windows(zone, a, hours)) {
    const begin = Math.max(open, a);
    if (close <= begin) continue;
    if (left <= close - begin) return new Date(begin + left);
    left -= close - begin;
  }
  return new Date(a + left);
}

// ── The clock ───────────────────────────────────────────────────────────────

export interface SlaState {
  readonly createdAt: Date;
  readonly status: 'open' | 'waiting' | 'closed';
  readonly closedAt: Date | null;
  readonly timezone: string | null;
  readonly firstResponseMinutes: number | null;
  readonly resolutionMinutes: number | null;
  readonly firstResponseAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pausedMinutes: number;
}

export interface SlaClockView {
  readonly paused: boolean;
  readonly firstResponse: {
    readonly targetMinutes: number;
    readonly elapsedMinutes: number;
    readonly dueAt: string;
    readonly respondedAt: string | null;
    readonly breached: boolean;
  };
  readonly resolution: {
    readonly targetMinutes: number;
    readonly elapsedMinutes: number;
    /** Null while paused: the deadline moves with the pause. */
    readonly dueAt: string | null;
    readonly resolvedAt: string | null;
    readonly breached: boolean;
  };
  readonly breached: boolean;
}

/** Null for a thread opened before 0352 (no targets captured). */
export function slaClock(state: SlaState, now: Date): SlaClockView | null {
  if (state.firstResponseMinutes === null || state.resolutionMinutes === null) return null;
  const zone = validTimeZone(state.timezone);
  const bm = (to: Date) => businessMinutesBetween(state.createdAt, to, zone);

  const firstEnd = state.firstResponseAt ?? now;
  const firstElapsed = bm(firstEnd);

  const resolvedAt = state.status === 'closed' ? (state.closedAt ?? now) : null;
  const end = resolvedAt ?? now;
  const pausing = state.pausedAt !== null && resolvedAt === null;
  const paused =
    state.pausedMinutes +
    (pausing && state.pausedAt ? businessMinutesBetween(state.pausedAt, end, zone) : 0);
  const resolutionElapsed = Math.max(0, bm(end) - paused);

  const firstBreached = firstElapsed > state.firstResponseMinutes;
  const resolutionBreached = resolutionElapsed > state.resolutionMinutes;
  return {
    paused: pausing,
    firstResponse: {
      targetMinutes: state.firstResponseMinutes,
      elapsedMinutes: firstElapsed,
      dueAt: addBusinessMinutes(state.createdAt, state.firstResponseMinutes, zone).toISOString(),
      respondedAt: state.firstResponseAt?.toISOString() ?? null,
      breached: firstBreached,
    },
    resolution: {
      targetMinutes: state.resolutionMinutes,
      elapsedMinutes: resolutionElapsed,
      dueAt: pausing
        ? null
        : addBusinessMinutes(
            state.createdAt,
            state.resolutionMinutes + state.pausedMinutes,
            zone,
          ).toISOString(),
      resolvedAt: resolvedAt?.toISOString() ?? null,
      breached: resolutionBreached,
    },
    breached: firstBreached || resolutionBreached,
  };
}

/**
 * The pause columns after a status change at `at`: entering `waiting` starts a pause; leaving it
 * adds the paused business minutes. Closing while paused folds the pause in too.
 */
export function pauseAfterStatus(
  state: Pick<SlaState, 'status' | 'pausedAt' | 'pausedMinutes' | 'timezone'>,
  next: 'open' | 'waiting' | 'closed',
  at: Date,
): { readonly pausedAt: Date | null; readonly pausedMinutes: number } {
  if (next === 'waiting') {
    return { pausedAt: state.pausedAt ?? at, pausedMinutes: state.pausedMinutes };
  }
  if (state.pausedAt === null) return { pausedAt: null, pausedMinutes: state.pausedMinutes };
  const added = businessMinutesBetween(state.pausedAt, at, validTimeZone(state.timezone));
  return { pausedAt: null, pausedMinutes: state.pausedMinutes + added };
}
