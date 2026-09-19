/**
 * Quiet hours — INBOX-001, the honouring half of NOTIF-001.
 *
 * NOTIF-001 (x54) added the `notification_preferences` columns `quiet_hours_start`,
 * `quiet_hours_end` and `quiet_hours_timezone` and stored them; nothing read them. This module
 * is the pure decision the delivery seam reads: whether a given instant falls inside a
 * recipient's quiet window, whether an event type is exempt, and — for a deferred delivery —
 * when the window next ends.
 *
 * ## What the plan asks for (planning `01`/`03`/`09`/`24`/`35`)
 *
 * - `03-TECHNICAL-ARCHITECTURE` §… "Every channel observes quiet hours" — but the in-app
 *   record is written regardless; only the *interrupting* channels (email, push) wait. The
 *   seam enforces that split; this module only answers "is it quiet now".
 * - `09-MVP-PRD`: "quiet hours and digest are honored except explicitly classified critical
 *   security events." `24-EVENT-CATALOG` §4 marks those events `yes-critical`; they bypass —
 *   see {@link QUIET_HOURS_BYPASS_EVENT_TYPES}.
 *
 * ## Pure, and timezone-correct without a dependency
 *
 * Everything here is a pure function of `(now, preferences)`. The recipient's wall clock is
 * read through `Intl.DateTimeFormat` in their stored IANA zone — no `Date` mutation, no new
 * dependency (brief scope (b)). A window that crosses midnight (`22:00`–`07:00`) is the normal
 * case, so it is handled first-class rather than as an exception.
 */

/** The three columns that describe a window, as the row and the API view carry them. */
export interface QuietHoursPreferences {
  /** Wall-clock `HH:MM` or `HH:MM:SS` in {@link quietHoursTimezone}, or null for none. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  /** An IANA zone name, or null. All three must be set for a window to exist. */
  readonly quietHoursTimezone: string | null;
}

/**
 * The event types `24-EVENT-CATALOG` §4 marks `yes-critical` — the "explicitly classified
 * critical security events" `09-MVP-PRD` exempts from quiet hours. A critical event interrupts
 * even at 3am because the cost of holding it until morning (a revoked session still live, an
 * export unseen, a plan change unbilled) is worse than the interruption.
 *
 * The names are string literals rather than `OutboxEventType`s on purpose: none of these
 * events has a producer yet (see `packages/domain/src/events/outbox.ts`, whose catalog lists
 * only the built ones), so binding to that union would not compile. When a producer is built,
 * its type joins the union and this set already exempts it — the classification leads the
 * wiring rather than trailing it.
 */
export const QUIET_HOURS_BYPASS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'membership.suspended.v1',
  'deliverable.published.v1',
  'approval.decided.v1',
  'approval.invalidated.v1',
  'audit.export_requested.v1',
  'entitlement.changed.v1',
  'subscription.changed.v1',
]);

/** Whether an event type interrupts through the window — `24-EVENT-CATALOG`'s `yes-critical`. */
export function eventTypeBypassesQuietHours(type: string): boolean {
  return QUIET_HOURS_BYPASS_EVENT_TYPES.has(type);
}

/**
 * A per-event bypass rule the type-keyed {@link QUIET_HOURS_BYPASS_EVENT_TYPES} cannot express,
 * decided from the event's own payload — the smallest generic extension USAGE-001 slice 4c's
 * brief asked for over a special case in the consumer.
 *
 * `usage.threshold_reached.v1` is the first case: `09-MVP-PRD`/`49-PRICING…` §6 make only the
 * **100%** crossing critical (new reservations are already blocked — an owner unaware of it is
 * a studio that has stopped accepting uploads), while the 70/85/95 warnings are advisory and
 * defer like any other interrupting mail. A single event *type* cannot say "critical only at
 * band 100", so the rule reads the payload's `band` here.
 */
export type QuietHoursBypassPredicate = (payload: Record<string, unknown>) => boolean;

/**
 * Per-type payload predicates, checked after the type-keyed set. Keyed by event type, so a new
 * event with a payload-conditional bypass registers one entry rather than teaching every
 * delivery seam a new rule. `band` is a number on the `usage.threshold_reached.v1` payload the
 * x63 producer writes; a missing or non-100 band defers.
 */
export const QUIET_HOURS_BYPASS_PAYLOAD_PREDICATES: ReadonlyMap<string, QuietHoursBypassPredicate> =
  new Map([['usage.threshold_reached.v1', (payload) => payload['band'] === 100]]);

/**
 * Whether an event interrupts through the window — by its type (the `yes-critical` set) or by a
 * per-type payload predicate. The superset of {@link eventTypeBypassesQuietHours} that a
 * payload-conditional event (USAGE-001's band-100 crossing) needs; a type-only caller can keep
 * using {@link eventTypeBypassesQuietHours} unchanged.
 */
export function eventBypassesQuietHours(type: string, payload: Record<string, unknown>): boolean {
  if (QUIET_HOURS_BYPASS_EVENT_TYPES.has(type)) return true;
  const predicate = QUIET_HOURS_BYPASS_PAYLOAD_PREDICATES.get(type);
  return predicate !== undefined && predicate(payload);
}

/**
 * Whether `value` is a zone `Intl` accepts — brief scope (c). The `DateTimeFormat` probe is the
 * authoritative check: it throws `RangeError` for an unknown zone and accepts every real one,
 * which is exactly the set the delivery seam later feeds to `Intl`. It is preferred over
 * `Intl.supportedValuesOf('timeZone')`, whose list omits the `'UTC'` alias in some ICU builds
 * even though `DateTimeFormat` accepts it. Rejects `'Mars/Phobos'` and `''`; accepts `'UTC'`
 * and `'Europe/London'`.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `'HH:MM'` / `'HH:MM:SS'` → seconds since local midnight, or null if unparseable. */
function secondsOfDay(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

/** The recipient's wall-clock seconds-of-day at `now`, read in their IANA zone. */
function wallClockSecondsOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const find = (type: string): number => {
      const part = parts.find((candidate) => candidate.type === type);
      return part === undefined ? Number.NaN : Number(part.value);
    };
    const hours = find('hour');
    const minutes = find('minute');
    const seconds = find('second');
    if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
    // `h23` renders midnight as hour 24 in some ICU builds; normalise it to 0.
    return ((hours % 24) * 3600 + minutes * 60 + seconds) % 86400;
  } catch {
    return null;
  }
}

/**
 * A window as seconds-of-day, or null when the preferences describe none: any column unset, a
 * malformed time, an unknown zone, or `start === end` (an empty window — a person who wants no
 * quiet hours clears the fields; a zero-length window is never "all day", which would silence
 * every interrupting channel for ever).
 */
function windowOf(
  prefs: QuietHoursPreferences,
): { readonly start: number; readonly end: number; readonly timeZone: string } | null {
  const { quietHoursStart, quietHoursEnd, quietHoursTimezone } = prefs;
  if (quietHoursStart === null || quietHoursEnd === null || quietHoursTimezone === null) {
    return null;
  }
  if (!isValidTimeZone(quietHoursTimezone)) return null;
  const start = secondsOfDay(quietHoursStart);
  const end = secondsOfDay(quietHoursEnd);
  if (start === null || end === null || start === end) return null;
  return { start, end, timeZone: quietHoursTimezone };
}

/**
 * Whether `now` falls inside the recipient's quiet window. False whenever the preferences
 * describe no window (see {@link windowOf}). The window is half-open `[start, end)` so the
 * instant the window ends is already out of it — {@link quietHoursResumeAt} relies on that to
 * avoid rescheduling a resumed delivery back into the window.
 *
 * Cross-midnight (`start > end`, e.g. `22:00`–`07:00`) is inside when the clock is at or past
 * the start *or* before the end; a same-day window (`start < end`) is the plain between.
 */
export function isInQuietHours(now: Date, prefs: QuietHoursPreferences | null): boolean {
  if (prefs === null) return false;
  const window = windowOf(prefs);
  if (window === null) return false;
  const nowSec = wallClockSecondsOfDay(now, window.timeZone);
  if (nowSec === null) return false;
  if (window.start < window.end) {
    return nowSec >= window.start && nowSec < window.end;
  }
  // Crosses midnight.
  return nowSec >= window.start || nowSec < window.end;
}

/**
 * The instant the current window next ends, for a delivery deferred at `now` — the
 * `available_at` a deferred interrupting delivery is rescheduled to. Null when `now` is not in
 * quiet hours (nothing to defer).
 *
 * Computed as a wall-clock duration added to `now`: the seconds from the recipient's current
 * time-of-day to `end`, wrapping past midnight. This is DST-tolerant rather than DST-exact — a
 * window spanning a clock change resumes within an hour of the true boundary — and the resumed
 * delivery re-checks {@link isInQuietHours}, so an early resume simply defers again. Converting
 * a wall-clock end back to a UTC instant exactly would need a timezone database this module is
 * forbidden a dependency for; the approximation is the right trade for a resume time.
 */
export function quietHoursResumeAt(now: Date, prefs: QuietHoursPreferences | null): Date | null {
  if (prefs === null) return null;
  const window = windowOf(prefs);
  if (window === null) return null;
  const nowSec = wallClockSecondsOfDay(now, window.timeZone);
  if (nowSec === null) return null;
  const inWindow =
    window.start < window.end
      ? nowSec >= window.start && nowSec < window.end
      : nowSec >= window.start || nowSec < window.end;
  if (!inWindow) return null;
  // Seconds forward to the end boundary, wrapping across midnight. Never 0 inside a window.
  const secondsUntilEnd = (window.end - nowSec + 86400) % 86400;
  return new Date(now.getTime() + secondsUntilEnd * 1000);
}
