import { ApiError } from '../../common/http/errors.js';

/**
 * 52-01 — the closed lists, org settings and request bounds of time tracking. Pure functions, so
 * the controller, the service and the unit test share one reading of every rule.
 */

export const TIME_LOG_SOURCES = ['manual', 'timer'] as const;
export type TimeLogSource = (typeof TIME_LOG_SOURCES)[number];

/** A manual entry with a start and end may reach back at most this far (spec: 31 days). */
export const MANUAL_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;
/** One entry covers at most one day. */
export const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
/** `time_timers.note` / `work_item_time_logs.note` are `VARCHAR(500)`. */
export const MAX_NOTE_LENGTH = 500;

export const AUTOSTOP_MIN_HOURS = 4;
export const AUTOSTOP_MAX_HOURS = 24;
export const AUTOSTOP_DEFAULT_HOURS = 12;

/** The time keys an organization may carry in `org_policies.policy_json` (0072). */
export interface TimePolicy {
  /** A forgotten timer is stopped by the worker after this many hours (4..24, default 12). */
  readonly autostopHours: number;
  /** Whether members may see who is tracking right now (`GET …/time/active`). Default off. */
  readonly presenceVisible: boolean;
}

export const DEFAULT_TIME_POLICY: TimePolicy = Object.freeze({
  autostopHours: AUTOSTOP_DEFAULT_HOURS,
  presenceVisible: false,
});

/**
 * Read the time keys from a stored policy document. The column is JSON; the driver may hand it
 * back parsed or as text. Anything absent, malformed or out of range reads as the default, so a
 * hand-edited row can only ever narrow back to the safe value (presence off, 12 h).
 */
export function parseTimePolicy(raw: unknown): TimePolicy {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return DEFAULT_TIME_POLICY;
    }
  }
  if (typeof doc !== 'object' || doc === null) return DEFAULT_TIME_POLICY;
  const record = doc as Record<string, unknown>;
  const hours = record['time_autostop_hours'];
  return {
    autostopHours:
      typeof hours === 'number' &&
      Number.isInteger(hours) &&
      hours >= AUTOSTOP_MIN_HOURS &&
      hours <= AUTOSTOP_MAX_HOURS
        ? hours
        : AUTOSTOP_DEFAULT_HOURS,
    presenceVisible: record['time_presence_visible'] === true,
  };
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export function optionalNote(raw: unknown, field = 'note'): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid(field, 'must be a string');
  const note = raw.trim();
  if (note === '') return null;
  if (note.length > MAX_NOTE_LENGTH) {
    throw invalid(field, `must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }
  return note;
}

export function optionalBoolean(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw invalid(field, 'must be true or false');
  return raw;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function optionalId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) throw invalid(field, 'must be an id');
  return raw.toLowerCase();
}

/** A start/end pair on a manual entry, both or neither. */
export interface ManualSpan {
  readonly startedAt: Date;
  readonly endedAt: Date;
}

/**
 * Parse `startedAt` / `endedAt` on a manual entry. Both or neither; ISO timestamps; end after
 * start; at most one day long; and inside `[now - 31 days, now]` (a small clock skew of one minute
 * is tolerated at the upper end). `null` when neither was sent.
 */
export function parseManualSpan(startRaw: unknown, endRaw: unknown, now: Date): ManualSpan | null {
  if ((startRaw === undefined || startRaw === null) && (endRaw === undefined || endRaw === null)) {
    return null;
  }
  const startedAt = timestamp(startRaw, 'startedAt');
  const endedAt = timestamp(endRaw, 'endedAt');
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw invalid('endedAt', 'must be after startedAt');
  }
  if (endedAt.getTime() - startedAt.getTime() > MAX_SPAN_MS) {
    throw invalid('endedAt', 'one entry covers at most 24 hours');
  }
  const floor = now.getTime() - MANUAL_LOOKBACK_MS;
  const ceiling = now.getTime() + 60_000;
  if (startedAt.getTime() < floor) throw invalid('startedAt', 'must be within the last 31 days');
  if (endedAt.getTime() > ceiling) throw invalid('endedAt', 'must not be in the future');
  return { startedAt, endedAt };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function timestamp(raw: unknown, field: string): Date {
  if (typeof raw !== 'string' || !ISO.test(raw)) {
    throw invalid(field, 'must be an ISO 8601 timestamp with a zone');
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw invalid(field, 'must be a valid timestamp');
  return value;
}

/** The UTC calendar day of an instant, the `spent_on` a timed entry is filed under. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** A lock window as `isWithinLockedPeriod` reads it; a reopened lock (`unlockedAt` set) holds nothing. */
export interface LockedPeriod {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unlockedAt?: Date | null;
}

/**
 * 52-03 — is a `spent_on` day (`YYYY-MM-DD`) inside an open lock? ISO dates compare as strings;
 * both ends are inclusive.
 */
export function isWithinLockedPeriod(spentOn: string, locks: readonly LockedPeriod[]): boolean {
  return locks.some(
    (lock) =>
      (lock.unlockedAt ?? null) === null &&
      spentOn >= lock.periodStart &&
      spentOn <= lock.periodEnd,
  );
}
