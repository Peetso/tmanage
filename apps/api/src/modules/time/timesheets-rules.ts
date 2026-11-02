import {
  hasCapability,
  isCustomRoleId,
  isInternalRole,
  isIsoDate,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { FinanceCandidate } from './locks-rules.js';
import { MAX_ENTRY_MINUTES } from './time-rounding.js';
import {
  optionalBoolean,
  optionalId,
  optionalNote,
  periodContaining,
  weekBounds,
} from './time-rules.js';
import type { WeekBounds } from './time-rules.js';

/**
 * 52-02 / 52-03 — the closed lists and request bounds of timesheets. Pure functions, so the service
 * and the unit test share one reading of every rule.
 */

export const TIMESHEET_STATES = ['open', 'submitted', 'approved', 'changes_requested'] as const;
export type TimesheetState = (typeof TIMESHEET_STATES)[number];

/** The states in which the member may still change their week. */
export const MEMBER_EDITABLE: readonly TimesheetState[] = ['open', 'changes_requested'];

/** One batch edit carries at most this many entries (a full week of a busy person, with room). */
export const MAX_BATCH_ENTRIES = 200;
/** One move carries at most this many entries. */
export const MAX_MOVE_ENTRIES = 200;
/** All entries of one day together never exceed a day. */
export const MAX_DAY_MINUTES = 24 * 60;
/** A day over this many minutes shows red on the team view. */
export const LONG_DAY_MINUTES = 12 * 60;
/** Request-changes note bounds. */
export const DECISION_NOTE_MIN = 3;
export const DECISION_NOTE_MAX = 500;

export const TIMESHEET_SUBMITTED_NOTICE = 'timesheet.submitted';
export const TIMESHEET_APPROVED_NOTICE = 'timesheet.approved';
export const TIMESHEET_CHANGES_NOTICE = 'timesheet.changes_requested';

function invalid(field: string, message: string, status = 400): ApiError {
  return new ApiError(status, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);

export const notOpen = (): ApiError =>
  new ApiError(409, 'conflict', 'This timesheet is not open for edits.', [
    { field: 'state', message: 'timesheet_not_open' },
  ]);

export const notSubmitted = (): ApiError =>
  new ApiError(409, 'conflict', 'This timesheet is not waiting for a decision.', [
    { field: 'state', message: 'timesheet_not_submitted' },
  ]);

export const entryLocked = (): ApiError =>
  new ApiError(409, 'conflict', 'This entry is in a locked period.', [
    { field: 'lockedAt', message: 'time_log_locked' },
  ]);

export const cannotApproveOwn = (): ApiError =>
  new ApiError(403, 'forbidden', 'You cannot decide on your own timesheet.', [
    { field: 'timesheetId', message: 'cannot_approve_own' },
  ]);

/** 409 with both versions, so the client can show "changed elsewhere" and reload (INT-09). */
export function staleVersion(sent: number, current: number): ApiError {
  return new ApiError(409, 'conflict', 'This timesheet changed since you opened it.', [
    { field: 'version', message: `version_conflict:sent=${sent}:current=${current}` },
  ]);
}

export function dayOverflow(day: string): ApiError {
  return invalid('entries', `day_over_24h:${day}`, 422);
}

export function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A path id, or the same 404 an absent row gives. */
export function pathId(raw: string): string {
  const id = optionalId(raw, 'timesheetId');
  if (id === null) throw notFound();
  return id;
}

/** `?week=YYYY-Www`, or the week containing `today` when absent. */
export function parseWeek(raw: unknown, weekStart: number, today: string): WeekBounds {
  if (raw === undefined || raw === null || raw === '') return periodContaining(today, weekStart);
  const bounds = typeof raw === 'string' ? weekBounds(raw, weekStart) : null;
  if (bounds === null) throw invalid('week', 'must be an ISO week like 2026-W44');
  const year = Number(bounds.periodStart.slice(0, 4));
  if (year < 2000 || year > 2100) throw invalid('week', 'must be between 2000 and 2100');
  return bounds;
}

export function parseVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw invalid('version', 'must be the version you read');
  }
  return raw;
}

/** One line of the batch edit. `id` absent = a new entry. */
export interface EntryInput {
  readonly id: string | null;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly spentOn: string;
  readonly minutes: number;
  readonly billable: boolean | undefined;
  readonly note: string | null;
}

/**
 * Parse the batch: 1..{@link MAX_BATCH_ENTRIES} lines, each with a day inside the week and
 * 1..1440 minutes. One bad line refuses the whole batch (nothing is written).
 */
export function parseEntries(raw: unknown, bounds: WeekBounds): readonly EntryInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('entries', 'must be a non-empty list');
  if (raw.length > MAX_BATCH_ENTRIES) {
    throw invalid('entries', `must hold ${MAX_BATCH_ENTRIES} entries or fewer`);
  }
  const seen = new Set<string>();
  return raw.map((line: unknown, index) => {
    const at = `entries[${index}]`;
    const input = record(line);
    const id = optionalId(input['id'], `${at}.id`);
    if (id !== null) {
      if (seen.has(id)) throw invalid(`${at}.id`, 'is listed twice');
      seen.add(id);
    }
    const spentOn = input['spentOn'];
    if (!isIsoDate(spentOn)) throw invalid(`${at}.spentOn`, 'must be a date YYYY-MM-DD');
    if (spentOn < bounds.periodStart || spentOn > bounds.periodEnd) {
      throw invalid(`${at}.spentOn`, 'must be inside the timesheet week', 422);
    }
    const minutes = input['minutes'];
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_ENTRY_MINUTES
    ) {
      throw invalid(`${at}.minutes`, `must be a whole number from 1 to ${MAX_ENTRY_MINUTES}`);
    }
    return {
      id,
      workItemId: optionalId(input['workItemId'], `${at}.workItemId`),
      projectId: optionalId(input['projectId'], `${at}.projectId`),
      spentOn,
      minutes,
      billable:
        input['billable'] === undefined
          ? undefined
          : optionalBoolean(input['billable'], `${at}.billable`, true),
      note: optionalNote(input['note'], `${at}.note`),
    };
  });
}

export function parseEntryIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw invalid('entryIds', 'must be a non-empty list');
  if (raw.length > MAX_MOVE_ENTRIES) {
    throw invalid('entryIds', `must hold ${MAX_MOVE_ENTRIES} ids or fewer`);
  }
  const ids = raw.map((value: unknown, index) => {
    const id = optionalId(value, `entryIds[${index}]`);
    if (id === null) throw invalid(`entryIds[${index}]`, 'must be an id');
    return id;
  });
  return [...new Set(ids)];
}

/** The request-changes note: required, 3..500 characters after trimming. */
export function parseDecisionNote(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('note', 'is required');
  const note = raw.trim();
  if (note.length < DECISION_NOTE_MIN || note.length > DECISION_NOTE_MAX) {
    throw invalid('note', `must be ${DECISION_NOTE_MIN} to ${DECISION_NOTE_MAX} characters`);
  }
  return note;
}

/** The first day whose summed minutes exceed a day, or `null`. */
export function overflowingDay(
  entries: readonly { readonly spentOn: string; readonly minutes: number }[],
): string | null {
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const sum = (byDay.get(entry.spentOn) ?? 0) + entry.minutes;
    if (sum > MAX_DAY_MINUTES) return entry.spentOn;
    byDay.set(entry.spentOn, sum);
  }
  return null;
}

/**
 * Who holds `capability` among the candidates (built-in role or custom role row). The holder rule
 * of `locks-rules.ts financeManagers`, for any capability (that one is bound to `finance.manage`).
 */
export function capabilityHolders(
  candidates: readonly FinanceCandidate[],
  capability: Capability,
): string[] {
  const out = new Set<string>();
  for (const candidate of candidates) {
    const holds = isInternalRole(candidate.role)
      ? hasCapability(candidate.role, capability)
      : isCustomRoleId(candidate.role.toLowerCase()) &&
        candidate.customCapabilitiesJson !== null &&
        parseCustomRoleCapabilities(candidate.customCapabilitiesJson).includes(capability);
    if (holds) out.add(candidate.userId);
  }
  return [...out];
}
