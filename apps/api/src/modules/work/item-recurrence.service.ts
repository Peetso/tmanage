import {
  RECURRENCE_EDIT_SCOPES,
  RECURRENCE_EDITOR_PREVIEW,
  RECURRENCE_HOLIDAY_POLICIES,
  RECURRENCE_MAX_SPAWN_AHEAD_DAYS,
  RECURRENCE_SPAWN_MODES,
  RECURRENCE_WEEKDAYS,
  RecurrenceValidationError,
  authorize,
  defaultWorkingCalendar,
  isIsoDate,
  isValidTimeZone,
  localDateOf,
  occurrenceKey,
  occurrencesOf,
  parseRecurrence,
  ruleForEdit,
  toRRule,
  weekdayOf,
  weekdaysOfMask,
} from '@tmanage/domain';
import type {
  AuditAction,
  AuditMetadata,
  Occurrence,
  Principal,
  RecurrenceEditScope,
  RecurrenceFields,
  RecurrenceHolidayPolicy,
  RecurrenceRule,
  WorkingCalendar,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRecurrenceRow, WorkItemRow } from '../../common/database/schema.js';
import { WORK_ITEM_RECURRENCE_FREQS } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemRecurrenceRepository } from './item-recurrence.repository.js';
import type { RecurrenceV2Columns } from './item-recurrence.repository.js';

/**
 * x257's application service — a work item's recurrence rule (Work module 7), extended by 53-09.
 *
 * ## Resolve the item, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path; the parent work item is read first, scoped to the
 * acting tenant — a cross-tenant `work_item_id` simply does not resolve, and the answer is the same
 * 404 an absent id gives, before `authorize()` is ever asked and before any write.
 *
 * ## 53-09 v2
 *
 * PUT accepts the v2 body (`preset` | `rrule` | fields, `spawnMode`, `spawnAheadDays`,
 * `holidayPolicy`, `countLimit`, `timeZone`, `startsOn`, `endsOn`) validated by the domain's
 * allowlisted RRULE subset (a refusal is 422 with audit code `recurrence_invalid`); the old
 * `{freq, interval, until}` body keeps its 400s and is mapped onto the subset when it fits. A v2
 * save snapshots the seed item into `template_json` and makes the caller the rule owner — the
 * spawner creates items under the owner's permission and pauses the rule if it is lost.
 * Capabilities: read/preview `work.read`; set/skip/pause/resume/end/generate-next `work.update` on
 * the seed item. Preview and generate-next write nothing.
 */

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 365;
export const RECURRENCE_PREVIEW_DEFAULT = 10;
export const RECURRENCE_PREVIEW_MAX = 30;
const NEXT_DATES_IN_VIEW = 5;

/** Where the org calendar comes from (the module wires the 53-02 repository). */
export interface RecurrenceCalendarSource {
  calendarOf(runner: TenantQueryRunner, context: TenantContext): Promise<WorkingCalendar>;
}

/** No calendar wired (unit tests): the default Sun–Thu calendar in UTC. */
export const DEFAULT_RECURRENCE_CALENDAR: RecurrenceCalendarSource = {
  calendarOf: async () => defaultWorkingCalendar('UTC'),
};

/** The org calendar with its holidays, else the default in the org's zone (schedule-cascade's). */
export function workingCalendarSource(
  calendars: WorkingCalendarRepository,
): RecurrenceCalendarSource {
  return {
    async calendarOf(runner, context) {
      const row = await calendars.findCalendar(runner, context, null);
      if (!row)
        return defaultWorkingCalendar(await calendars.organizationTimeZone(runner, context));
      const holidays = await calendars.listHolidays(runner, context, row.id);
      return {
        workingDaysMask: Number(row.workingDaysMask),
        dayStart: String(row.dayStart),
        dayEnd: String(row.dayEnd),
        timeZone: row.timeZone,
        holidays: new Set(holidays.map((h) => h.date)),
      };
    },
  };
}

/**
 * The rule a stored row means, or `null` when it cannot be read as the subset (a legacy interval
 * above 52, or a corrupted row). A legacy row (no `rrule`) is anchored on its creation day.
 */
export function ruleOfRow(row: WorkItemRecurrenceRow, timeZone: string): RecurrenceRule | null {
  try {
    if (row.rrule) {
      return parseRecurrence(row.rrule, row.startsOn ?? localDateOf(row.createdAt, timeZone));
    }
    return parseRecurrence(
      {
        freq: row.freq.toUpperCase(),
        interval: row.intervalCount,
        until: row.untilAt ? localDateOf(row.untilAt, timeZone) : null,
      },
      localDateOf(row.createdAt, timeZone),
    );
  } catch {
    return null;
  }
}

export function holidayPolicyOf(row: WorkItemRecurrenceRow): RecurrenceHolidayPolicy {
  const raw = row.holidayPolicy as RecurrenceHolidayPolicy | undefined;
  return raw && RECURRENCE_HOLIDAY_POLICIES.includes(raw) ? raw : 'next_working_day';
}

/** The client-facing projection of a recurrence rule. Paired in `apps/web`. */
export interface WorkItemRecurrenceView {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly until: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  // ---- 53-09 ----
  readonly rrule: string | null;
  readonly startsOn: string | null;
  readonly byWeekday: readonly string[];
  readonly byMonthDay: number | null;
  readonly bySetPos: number | null;
  readonly countLimit: number | null;
  readonly timeZone: string | null;
  readonly spawnMode: string;
  readonly spawnAheadDays: number;
  readonly holidayPolicy: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  readonly lastOccurrenceKey: string | null;
  readonly nextDates: readonly Occurrence[];
}

/** The computed next occurrence — what `generate-next` returns; it is not persisted. */
export interface NextOccurrenceView {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  /** The instant the computation started from (the bound clock). */
  readonly from: string;
  /** The next occurrence, or `null` when the rule is exhausted (past its `until` bound). */
  readonly nextAt: string | null;
  readonly exhausted: boolean;
  /** 53-09: the next occurrence as a civil date with its key (null when exhausted). */
  readonly next?: Occurrence | null;
}

export interface RecurrencePreviewView {
  readonly workItemId: string;
  readonly occurrences: readonly Occurrence[];
}

/** The PUT body: legacy `{freq, interval, until}` or the v2 shape. Values are unvalidated. */
export interface SetRecurrenceInput {
  readonly freq?: unknown;
  readonly interval?: unknown;
  readonly until?: unknown;
  readonly preset?: unknown;
  readonly rrule?: unknown;
  readonly byWeekday?: unknown;
  readonly byMonthDay?: unknown;
  readonly bySetPos?: unknown;
  readonly count?: unknown;
  readonly countLimit?: unknown;
  readonly startsOn?: unknown;
  readonly endsOn?: unknown;
  readonly timeZone?: unknown;
  readonly spawnMode?: unknown;
  readonly spawnAheadDays?: unknown;
  readonly holidayPolicy?: unknown;
  /** r46: how far an edit reaches — `all` (keep the series start) or `this_and_future`. */
  readonly scope?: unknown;
  /** r46: the occurrence a `this_and_future` edit starts from (default: today). */
  readonly fromDate?: unknown;
}

const V2_KEYS: readonly (keyof SetRecurrenceInput)[] = [
  'preset',
  'rrule',
  'byWeekday',
  'byMonthDay',
  'bySetPos',
  'count',
  'countLimit',
  'startsOn',
  'endsOn',
  'timeZone',
  'spawnMode',
  'spawnAheadDays',
  'holidayPolicy',
  'scope',
  'fromDate',
];

/**
 * Compute the next occurrence strictly after `from`, or `null` when the rule is exhausted — the
 * x257 instant arithmetic, kept for a legacy rule the subset cannot read (interval above 52).
 */
export function computeNextOccurrence(
  rule: { readonly freq: string; readonly intervalCount: number; readonly untilAt: Date | null },
  from: Date,
): Date | null {
  const interval = rule.intervalCount;
  const next = new Date(from.getTime());
  switch (rule.freq) {
    case 'daily':
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + interval * 7);
      break;
    case 'monthly': {
      const day = next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + interval);
      const lastDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
      break;
    }
    default:
      return null;
  }
  if (rule.untilAt !== null && next.getTime() > rule.untilAt.getTime()) return null;
  return next;
}

export interface WorkItemRecurrenceServiceOptions {
  readonly calendars?: RecurrenceCalendarSource;
  readonly audit?: AuditService;
  readonly now?: () => Date;
}

export class WorkItemRecurrenceService {
  private readonly calendars: RecurrenceCalendarSource;
  private readonly now: () => Date;

  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly recurrence: WorkItemRecurrenceRepository = new WorkItemRecurrenceRepository(),
    private readonly options: WorkItemRecurrenceServiceOptions = {},
  ) {
    this.calendars = options.calendars ?? DEFAULT_RECURRENCE_CALENDAR;
    this.now = options.now ?? (() => new Date());
  }

  /** The recurrence rule for a work item with its next 5 dates, or `null`. Behind `work.read`. */
  async get(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRecurrenceView | null> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const row = await this.recurrence.findByItem(runner, context, workItemId);
      if (!row) return null;
      return this.toView(row, await this.calendars.calendarOf(runner, context));
    });
  }

  /** Set (upsert) the rule. Behind `work.update`. Legacy body: 400s; v2 body: 422 on the rule. */
  async set(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: SetRecurrenceInput,
  ): Promise<WorkItemRecurrenceView> {
    const legacy = isLegacyBody(input);
    // Shape checks that need no database come first, so a refused body never opens a transaction.
    const legacyFields = legacy
      ? {
          freq: requiredFreq(input.freq),
          intervalCount: requiredInterval(input.interval),
          untilAt: optionalUntil(input.until),
        }
      : null;
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const calendar = await this.calendars.calendarOf(tx, context);
      let row: WorkItemRecurrenceRow;
      if (legacyFields) {
        const start = localDateOf(this.now(), calendar.timeZone);
        let rule: RecurrenceRule | null = null;
        try {
          rule = parseRecurrence(
            {
              freq: legacyFields.freq.toUpperCase(),
              interval: legacyFields.intervalCount,
              until: legacyFields.untilAt
                ? localDateOf(legacyFields.untilAt, calendar.timeZone)
                : null,
            },
            start,
          );
        } catch {
          rule = null; // an interval above 52 stays a legacy (non-spawning) rule
        }
        row = await this.recurrence.upsert(tx, context, workItemId, {
          ...legacyFields,
          ...(rule
            ? {
                v2: v2Columns(rule, parent, principal, {
                  timeZone: null,
                  spawnMode: 'on_schedule',
                  spawnAheadDays: 1,
                  holidayPolicy: 'next_working_day',
                }),
              }
            : {}),
        });
      } else {
        const parsed = parseV2(input, calendar, this.now());
        const settings = parsed.settings;
        const rule = await this.scoped(tx, context, workItemId, input, parsed, calendar);
        row = await this.recurrence.upsert(tx, context, workItemId, {
          freq: rule.freq.toLowerCase(),
          intervalCount: rule.interval,
          untilAt: rule.until ? new Date(`${rule.until}T23:59:59.999Z`) : null,
          v2: v2Columns(rule, parent, principal, settings),
        });
      }
      await this.audited(tx, context, 'recurrence.updated', workItemId, {
        rule_freq: row.freq,
        spawn_mode: row.spawnMode ?? 'on_schedule',
        holiday_policy: row.holidayPolicy ?? 'next_working_day',
        materialised: row.rrule != null,
      });
      return this.toView(row, calendar);
    });
  }

  /** Clear the recurrence rule. Behind `work.update`. A no-op 204 when the item did not recur. */
  async clear(context: TenantContext, principal: Principal, workItemId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      await this.recurrence.deleteByItem(tx, context, workItemId);
    });
  }

  /** The next `count` (≤ 30) dates over the org calendar. Behind `work.read`. Writes nothing. */
  async preview(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    count: unknown,
  ): Promise<RecurrencePreviewView> {
    const n = previewCount(count);
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const row = await this.recurrence.findByItem(runner, context, workItemId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const calendar = await this.calendars.calendarOf(runner, context);
      return { workItemId, occurrences: this.upcoming(row, calendar, n) };
    });
  }

  /**
   * r46 — the next dates of an UNSAVED rule (the editor's live preview), with the same scope rules
   * a save would apply. Behind `work.read`; writes nothing. 422 on an invalid draft.
   */
  async previewDraft(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: SetRecurrenceInput,
  ): Promise<RecurrencePreviewView> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const calendar = await this.calendars.calendarOf(runner, context);
      const parsed = parseV2(input ?? {}, calendar, this.now());
      const rule = await this.scoped(runner, context, workItemId, input ?? {}, parsed, calendar);
      const zone = parsed.settings.timeZone ?? calendar.timeZone;
      const today = localDateOf(this.now(), zone);
      const policy = parsed.settings.holidayPolicy as RecurrenceHolidayPolicy;
      const after = rule.start > today ? previousDay(rule.start) : today;
      return {
        workItemId,
        occurrences: [...occurrencesOf(rule, after, RECURRENCE_EDITOR_PREVIEW, calendar, policy)],
      };
    });
  }

  /** Apply the edit scope to a parsed v2 rule against the stored rule (no scope: as parsed). */
  private async scoped(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    input: SetRecurrenceInput,
    parsed: { rule: RecurrenceRule; settings: V2Settings },
    calendar: WorkingCalendar,
  ): Promise<RecurrenceRule> {
    if (input.scope === undefined || input.scope === null) return parsed.rule;
    const scope = oneOf(input.scope, RECURRENCE_EDIT_SCOPES, 'all', 'scope') as RecurrenceEditScope;
    const zone = parsed.settings.timeZone ?? calendar.timeZone;
    const fromDate =
      input.fromDate === undefined || input.fromDate === null
        ? localDateOf(this.now(), zone)
        : input.fromDate;
    if (typeof fromDate !== 'string' || !isIsoDate(fromDate)) {
      throw invalid('fromDate', 'must be a date (YYYY-MM-DD)');
    }
    const stored = await this.recurrence.findByItem(runner, context, workItemId);
    const previous = stored ? ruleOfRow(stored, stored.timeZone ?? zone) : null;
    try {
      return ruleForEdit(parsed.rule, previous, scope, fromDate);
    } catch (error) {
      if (error instanceof RecurrenceValidationError) throw invalid(error.field, error.message);
      throw error;
    }
  }

  /** Skip one occurrence ahead of time. Behind `work.update`. A second skip of it is a 409. */
  async skip(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    rawKey: unknown,
  ): Promise<{ readonly occurrenceKey: string; readonly status: 'skipped' }> {
    let key: string;
    try {
      key = occurrenceKey(String(rawKey ?? ''));
    } catch {
      throw invalid('occurrenceKey', 'must be a date (YYYY-MM-DD)');
    }
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.recurrence.findByItem(tx, context, workItemId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const id = await this.recurrence.insertInstance(tx, context, {
        recurrenceId: row.id,
        occurrenceKey: key,
        status: 'skipped',
      });
      if (id === null) {
        throw new ApiError(
          409,
          'conflict',
          'This occurrence was already created or skipped',
          [{ field: 'occurrenceKey', message: 'occurrence_exists' }],
          'occurrence_exists',
        );
      }
      await this.audited(tx, context, 'recurrence.skipped', workItemId, { occurrence_key: key });
      return { occurrenceKey: key, status: 'skipped' as const };
    });
  }

  /** Pause, resume or end the series. Behind `work.update`. An ended series stays ended (409). */
  async changeStatus(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    to: 'paused' | 'active' | 'ended',
  ): Promise<WorkItemRecurrenceView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.recurrence.findByItem(tx, context, workItemId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const from = row.status ?? 'active';
      if (from === 'ended' && to !== 'ended') {
        throw new ApiError(409, 'conflict', 'This series has ended', undefined, 'recurrence_ended');
      }
      if (from !== to) {
        await this.recurrence.setStatus(tx, context, row.id, to);
        const action: AuditAction =
          to === 'paused'
            ? 'recurrence.paused'
            : to === 'active'
              ? 'recurrence.resumed'
              : 'recurrence.ended';
        await this.audited(tx, context, action, workItemId, { status_before: from });
      }
      const calendar = await this.calendars.calendarOf(tx, context);
      return this.toView({ ...row, status: to }, calendar);
    });
  }

  /**
   * The next occurrence over a bound clock. Behind `work.update`. Writes nothing. 53-09: computed
   * by the domain's `occurrencesOf` over the org calendar; the x257 instant arithmetic remains only
   * for a legacy rule the subset cannot read.
   */
  async generateNext(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    now: Date,
  ): Promise<NextOccurrenceView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.recurrence.findByItem(tx, context, workItemId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const calendar = await this.calendars.calendarOf(tx, context);
      const zone = row.timeZone ?? calendar.timeZone;
      const rule = ruleOfRow(row, zone);
      if (rule) {
        const after = localDateOf(now, zone);
        const [next] = occurrencesOf(rule, after, 1, calendar, holidayPolicyOf(row));
        return {
          workItemId,
          freq: row.freq,
          interval: row.intervalCount,
          from: now.toISOString(),
          nextAt: next ? new Date(`${next.date}T00:00:00.000Z`).toISOString() : null,
          exhausted: next === undefined,
          next: next ?? null,
        };
      }
      const nextAt = computeNextOccurrence(
        { freq: row.freq, intervalCount: row.intervalCount, untilAt: row.untilAt },
        now,
      );
      return {
        workItemId,
        freq: row.freq,
        interval: row.intervalCount,
        from: now.toISOString(),
        nextAt: nextAt ? nextAt.toISOString() : null,
        exhausted: nextAt === null,
      };
    });
  }

  private upcoming(row: WorkItemRecurrenceRow, calendar: WorkingCalendar, n: number): Occurrence[] {
    const zone = row.timeZone ?? calendar.timeZone;
    const rule = ruleOfRow(row, zone);
    if (!rule || (row.status ?? 'active') === 'ended') return [];
    const today = localDateOf(this.now(), zone);
    const after =
      row.lastOccurrenceKey && row.lastOccurrenceKey > today ? row.lastOccurrenceKey : today;
    return [...occurrencesOf(rule, after, n, calendar, holidayPolicyOf(row))];
  }

  private toView(row: WorkItemRecurrenceRow, calendar: WorkingCalendar): WorkItemRecurrenceView {
    return {
      workItemId: row.workItemId,
      freq: row.freq,
      interval: row.intervalCount,
      until: row.untilAt ? row.untilAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      rrule: row.rrule ?? null,
      startsOn: row.startsOn ?? null,
      byWeekday: row.byWeekday ? row.byWeekday.split(',') : [],
      byMonthDay: row.byMonthday ?? null,
      bySetPos: row.bySetpos ?? null,
      countLimit: row.countLimit ?? null,
      timeZone: row.timeZone ?? null,
      spawnMode: row.spawnMode ?? 'on_schedule',
      spawnAheadDays: row.spawnAheadDays ?? 1,
      holidayPolicy: row.holidayPolicy ?? 'next_working_day',
      status: row.status ?? 'active',
      ownerUserId: row.ownerUserId ?? null,
      lastOccurrenceKey: row.lastOccurrenceKey ?? null,
      nextDates: this.upcoming(row, calendar, NEXT_DATES_IN_VIEW),
    };
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    workItemId: string,
    metadata: AuditMetadata,
  ): Promise<void> {
    await this.options.audit?.record(tx, context, {
      action,
      objectId: workItemId,
      result: 'allowed',
      metadata,
    });
  }

  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

interface V2Settings {
  readonly timeZone: string | null;
  readonly spawnMode: string;
  readonly spawnAheadDays: number;
  readonly holidayPolicy: string;
}

/** The seed snapshot a spawned item is made from (re-validated on every spawn). */
export function templateOf(parent: WorkItemRow): Record<string, unknown> {
  return {
    title: parent.title,
    description: parent.description ?? null,
    type: parent.type,
    ownerUserId: parent.ownerUserId,
    audience: parent.audience,
  };
}

function v2Columns(
  rule: RecurrenceRule,
  parent: WorkItemRow,
  principal: Principal,
  settings: V2Settings,
): RecurrenceV2Columns {
  return {
    rrule: toRRule(rule),
    startsOn: rule.start,
    byWeekday:
      rule.byWeekday.length > 0
        ? rule.byWeekday.map((d) => RECURRENCE_WEEKDAYS[d]).join(',')
        : null,
    byMonthday: rule.byMonthDay,
    bySetpos: rule.bySetPos,
    timeZone: settings.timeZone,
    spawnMode: settings.spawnMode,
    spawnAheadDays: settings.spawnAheadDays,
    holidayPolicy: settings.holidayPolicy,
    countLimit: rule.count,
    templateJson: templateOf(parent),
    ownerUserId: principal.userId,
  };
}

function isLegacyBody(input: SetRecurrenceInput): boolean {
  if (input === null || typeof input !== 'object') return true;
  if (V2_KEYS.some((key) => input[key] !== undefined)) return false;
  return !(typeof input.freq === 'string' && input.freq === input.freq.toUpperCase());
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(
    422,
    'validation_failed',
    'The repeat rule is invalid',
    [{ field, message }],
    'recurrence_invalid',
  );
}

function oneOf(raw: unknown, allowed: readonly string[], fallback: string, field: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw invalid(field, `must be one of ${allowed.join(', ')}`);
  }
  return raw;
}

function presetFields(preset: unknown, start: string, calendar: WorkingCalendar): RecurrenceFields {
  const weekday = RECURRENCE_WEEKDAYS[weekdayOf(start)];
  switch (preset) {
    case 'daily':
      return { freq: 'DAILY' };
    case 'weekdays':
      return {
        freq: 'WEEKLY',
        byWeekday: weekdaysOfMask(calendar.workingDaysMask).map((d) => RECURRENCE_WEEKDAYS[d]),
      };
    case 'weekly':
      return { freq: 'WEEKLY', byWeekday: [weekday] };
    case 'monthly':
      return { freq: 'MONTHLY', byMonthDay: Number(start.slice(8)) };
    case 'monthly_nth': {
      const nth = Math.ceil(Number(start.slice(8)) / 7);
      return { freq: 'MONTHLY', byWeekday: [weekday], bySetPos: nth > 4 ? -1 : nth };
    }
    case 'yearly':
      return { freq: 'YEARLY' };
    default:
      throw invalid('preset', 'must be daily, weekdays, weekly, monthly, monthly_nth or yearly');
  }
}

function parseV2(
  input: SetRecurrenceInput,
  calendar: WorkingCalendar,
  now: Date,
): { rule: RecurrenceRule; settings: V2Settings } {
  let timeZone: string | null = null;
  if (input.timeZone !== undefined && input.timeZone !== null) {
    if (typeof input.timeZone !== 'string' || !isValidTimeZone(input.timeZone)) {
      throw invalid('timeZone', 'must be an IANA time zone');
    }
    timeZone = input.timeZone;
  }
  const start =
    input.startsOn === undefined || input.startsOn === null
      ? localDateOf(now, timeZone ?? calendar.timeZone)
      : input.startsOn;
  if (!isIsoDate(start)) throw invalid('startsOn', 'must be a date (YYYY-MM-DD)');

  const spawnAheadDays =
    input.spawnAheadDays === undefined || input.spawnAheadDays === null ? 1 : input.spawnAheadDays;
  if (
    typeof spawnAheadDays !== 'number' ||
    !Number.isInteger(spawnAheadDays) ||
    spawnAheadDays < 0 ||
    spawnAheadDays > RECURRENCE_MAX_SPAWN_AHEAD_DAYS
  ) {
    throw invalid(
      'spawnAheadDays',
      `must be an integer between 0 and ${RECURRENCE_MAX_SPAWN_AHEAD_DAYS}`,
    );
  }
  const settings: V2Settings = {
    timeZone,
    spawnMode: oneOf(input.spawnMode, RECURRENCE_SPAWN_MODES, 'on_schedule', 'spawnMode'),
    spawnAheadDays,
    holidayPolicy: oneOf(
      input.holidayPolicy,
      RECURRENCE_HOLIDAY_POLICIES,
      'next_working_day',
      'holidayPolicy',
    ),
  };

  try {
    let fields: RecurrenceFields;
    if (input.rrule !== undefined && input.rrule !== null) {
      if (typeof input.rrule !== 'string') throw invalid('rrule', 'must be a string');
      const fromText = parseRecurrence(input.rrule, start);
      fields = {
        freq: fromText.freq,
        interval: fromText.interval,
        byWeekday: fromText.byWeekday.map((d) => RECURRENCE_WEEKDAYS[d]),
        byMonthDay: fromText.byMonthDay,
        bySetPos: fromText.bySetPos,
        count: fromText.count,
        until: fromText.until,
      };
    } else if (input.preset !== undefined && input.preset !== null && input.preset !== 'custom') {
      fields = presetFields(input.preset, start, calendar);
    } else {
      fields = {
        freq: input.freq,
        interval: input.interval,
        byWeekday: input.byWeekday,
        byMonthDay: input.byMonthDay,
        bySetPos: input.bySetPos,
      };
    }
    const count = input.countLimit ?? input.count;
    fields = {
      ...fields,
      ...(count !== undefined ? { count } : {}),
      ...(input.endsOn !== undefined ? { until: input.endsOn } : {}),
    };
    return { rule: parseRecurrence(fields, start), settings };
  } catch (error) {
    if (error instanceof RecurrenceValidationError) throw invalid(error.field, error.message);
    throw error;
  }
}

/** The ISO date before `date`. */
function previousDay(date: string): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

function previewCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return RECURRENCE_PREVIEW_DEFAULT;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > RECURRENCE_PREVIEW_MAX) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'count', message: `must be an integer between 1 and ${RECURRENCE_PREVIEW_MAX}` },
    ]);
  }
  return n;
}

function requiredFreq(raw: unknown): string {
  if (typeof raw !== 'string' || !(WORK_ITEM_RECURRENCE_FREQS as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'freq', message: `must be one of: ${WORK_ITEM_RECURRENCE_FREQS.join(', ')}` },
    ]);
  }
  return raw;
}

function requiredInterval(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_INTERVAL ||
    raw > MAX_INTERVAL
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'interval',
        message: `must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}`,
      },
    ]);
  }
  return raw;
}

function optionalUntil(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'until', message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'until', message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  return at;
}
