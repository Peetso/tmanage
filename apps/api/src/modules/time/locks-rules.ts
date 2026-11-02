import {
  hasCapability,
  isCustomRoleId,
  isInternalRole,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';

/**
 * 52-03 — the request bounds of period locks. Pure functions, so the service and the unit test
 * share one reading of every rule.
 *
 * The plan's `time.lock` capability is a later registry slice; until it lands the lock and unlock
 * routes stand on {@link TIME_LOCK_CAPABILITY} = `finance.manage` (the plan files the screen under
 * Finance → Lock periods; the 52-23 stand-in rule) and the list on `finance.view`.
 */
export const TIME_LOCK_CAPABILITY: Capability = 'finance.manage';
export const TIME_LOCK_VIEW_CAPABILITY: Capability = 'finance.view';

/** Entries are stamped (and cleared) in batches of this many ids, one transaction per batch. */
export const LOCK_BATCH_SIZE = 500;
/** A member may ask to reopen one lock once per this window. */
export const UNLOCK_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A window lies within this many years of today, both ends. */
export const LOCK_HORIZON_YEARS = 5;
export const UNLOCK_REASON_MIN = 3;
export const UNLOCK_REASON_MAX = 500;
export const LOCK_PAGE_DEFAULT = 50;
export const LOCK_PAGE_MAX = 100;
/** The inbox notice type one unlock request fans out as. */
export const UNLOCK_REQUEST_NOTICE = 'time_lock.unlock_requested';

export interface LockWindow {
  /** `YYYY-MM-01`. */
  readonly periodStart: string;
  /** The last day of a month, `YYYY-MM-DD`, on or after `periodStart`. */
  readonly periodEnd: string;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date `YYYY-MM-DD` that exists, as its UTC midnight. */
function calendarDate(raw: unknown, field: string): Date {
  const match = typeof raw === 'string' ? DAY.exec(raw) : null;
  if (!match) throw invalid(field, 'must be a date (YYYY-MM-DD)');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw invalid(field, 'must be a valid date');
  }
  return value;
}

/**
 * Parse a lock window: whole calendar months only in v1 — the start is the first of a month, the
 * end the last day of a month, end on or after start — and both ends within five years of `now`.
 */
export function parseLockWindow(startRaw: unknown, endRaw: unknown, now: Date): LockWindow {
  const start = calendarDate(startRaw, 'periodStart');
  const end = calendarDate(endRaw, 'periodEnd');
  if (start.getUTCDate() !== 1) throw invalid('periodStart', 'must be the first day of a month');
  const next = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  if (next.getUTCDate() !== 1) throw invalid('periodEnd', 'must be the last day of a month');
  if (end.getTime() < start.getTime())
    throw invalid('periodEnd', 'must be on or after periodStart');
  const floor = Date.UTC(now.getUTCFullYear() - LOCK_HORIZON_YEARS, now.getUTCMonth(), 1);
  const ceiling = Date.UTC(now.getUTCFullYear() + LOCK_HORIZON_YEARS, now.getUTCMonth() + 1, 0);
  if (start.getTime() < floor) throw invalid('periodStart', 'must be within five years');
  if (end.getTime() > ceiling) throw invalid('periodEnd', 'must be within five years');
  return { periodStart: startRaw as string, periodEnd: endRaw as string };
}

/** The why of an unlock (or of a request to unlock): required, 3..500 characters once trimmed. */
export function parseUnlockReason(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('reason', 'is required');
  const reason = raw.trim();
  if (reason.length < UNLOCK_REASON_MIN || reason.length > UNLOCK_REASON_MAX) {
    throw invalid('reason', `must be ${UNLOCK_REASON_MIN} to ${UNLOCK_REASON_MAX} characters`);
  }
  return reason;
}

/** `?limit=` for the list: 1..100, default 50. */
export function parseLockPageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return LOCK_PAGE_DEFAULT;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LOCK_PAGE_MAX) {
    throw invalid('limit', `must be a whole number from 1 to ${LOCK_PAGE_MAX}`);
  }
  return value;
}

/** One active internal membership and, for a custom role, the capability list its row stores. */
export interface FinanceCandidate {
  readonly userId: string;
  readonly role: string;
  readonly customCapabilitiesJson: string | null;
}

/**
 * Who holds `finance.manage`: built-in internal roles by their ceiling, custom roles by their own
 * stored list (a missing row grants nothing). Client roles never qualify. Distinct user ids.
 */
export function financeManagers(candidates: readonly FinanceCandidate[]): string[] {
  const out = new Set<string>();
  for (const candidate of candidates) {
    const holds = isInternalRole(candidate.role)
      ? hasCapability(candidate.role, TIME_LOCK_CAPABILITY)
      : isCustomRoleId(candidate.role.toLowerCase()) &&
        candidate.customCapabilitiesJson !== null &&
        parseCustomRoleCapabilities(candidate.customCapabilitiesJson).includes(
          TIME_LOCK_CAPABILITY,
        );
    if (holds) out.add(candidate.userId);
  }
  return [...out];
}
