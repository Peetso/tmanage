import { authorize, dayNumberOf, principalHoldsCapability, toCsv } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TimesheetRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { TimeLocksRepository } from './locks.repository.js';
import type { AutoTimeFiler } from './time-auto-filing.js';
import {
  mayTrackOnItem,
  mayTrackOnProject,
  requireInternal,
  TIME_MANAGE_ANY,
} from './time-capabilities.js';
import {
  daysOf,
  isWithinLockedPeriod,
  optionalId,
  shiftDay,
  timesheetTotals,
  utcDay,
} from './time-rules.js';
import type { LockedPeriod, TimeLogSource, WeekBounds } from './time-rules.js';
import {
  cannotApproveOwn,
  capabilityHolders,
  dayOverflow,
  entryLocked,
  LONG_DAY_MINUTES,
  MEMBER_EDITABLE,
  notFound,
  notOpen,
  notSubmitted,
  notUnassigned,
  overflowingDay,
  parseDecisionNote,
  parseEntries,
  parseEntryIds,
  parseSplit,
  parseVersion,
  parseWeek,
  pathId,
  record,
  staleVersion,
  TIMESHEET_APPROVED_NOTICE,
  TIMESHEET_CHANGES_NOTICE,
  TIMESHEET_SUBMITTED_NOTICE,
} from './timesheets-rules.js';
import type { EntryInput, TimesheetState } from './timesheets-rules.js';
import type { TimesheetsRepository } from './timesheets.repository.js';

/**
 * 52-02 timesheets and the approval half of 52-03.
 *
 * - **Mine** (track own): the caller's week, its open row inserted on first read; entries grouped by
 *   project and item, totals, capacity (`person_capacity`), whether a period lock touches the week.
 * - **Team** (`TIME_MANAGE_ANY`): one row per internal member. Entries on projects the caller may
 *   not manage collapse into `otherProjectsMinutes` — never a title, never a note (AUTH-52-03).
 * - **Batch edit**: all or nothing in one transaction, under the row lock of the sheet and its
 *   optimistic `version` (409 with both versions). New entries go through
 *   `WorkTimeLogsRepository.create` — the store `WorkTimeLogsService.add()` writes through — so rate
 *   snapshots and the billable default stay in one place; `add()` itself opens its own transaction
 *   and could not join this one. Existing entries change minutes, day, billable and note only;
 *   locked ones are refused (409 `time_log_locked`). Every day stays within 24 h (422) and the
 *   totals are re-summed in the same transaction. A manager editing somebody else's week sets
 *   `edited_by_manager` and may touch only entries on projects they manage.
 * - **Submit** (own) notifies every `TIME_MANAGE_ANY` holder; **approve / request changes**
 *   (`TIME_MANAGE_ANY`, never one's own week, only over projects one manages) notify the member.
 * - **Copy from** another week copies the caller's own entries without notes; **export** is a CSV
 *   without notes, audited as an export.
 *
 * Org-internal: client principals are refused before anything is read.
 */

export interface TimesheetEntryView {
  readonly id: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly spentOn: string;
  readonly minutes: number;
  readonly billable: boolean;
  readonly note: string | null;
  readonly needsReview: boolean;
  readonly locked: boolean;
  /** `automatic` = reported by the person's device (FIX-2026-11-10), not verified. */
  readonly source: TimeLogSource;
}

export interface TimesheetGroupView {
  readonly projectId: string | null;
  readonly workItemId: string | null;
  readonly title: string | null;
  readonly minutes: number;
  readonly entries: readonly TimesheetEntryView[];
}

export interface TimesheetView {
  readonly id: string;
  readonly membershipId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: readonly string[];
  readonly state: TimesheetState;
  readonly version: number;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly editedByManager: boolean;
  readonly totalMinutes: number;
  readonly billableMinutes: number;
  readonly capacityMinutes: number | null;
  readonly locked: boolean;
  readonly needsReview: number;
  readonly groups: readonly TimesheetGroupView[];
  readonly otherProjectsMinutes: number;
}

export interface TeamMemberWeekView {
  readonly membershipId: string;
  readonly timesheetId: string | null;
  readonly state: TimesheetState;
  readonly version: number | null;
  readonly totalMinutes: number;
  readonly billableMinutes: number;
  readonly editedByManager: boolean;
  readonly missingDays: readonly string[];
  readonly longDays: readonly string[];
  readonly entries: readonly TimesheetEntryView[];
  readonly otherProjectsMinutes: number;
}

export interface TeamWeekView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly members: readonly TeamMemberWeekView[];
}

export interface TimesheetCsv {
  readonly filename: string;
  readonly body: string;
}

export interface TimesheetsServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    TimesheetsRepository,
    | 'weekStart'
    | 'findById'
    | 'ensure'
    | 'listForPeriod'
    | 'update'
    | 'entriesInPeriod'
    | 'updateEntry'
    | 'stampTimesheet'
    | 'fileUnder'
    | 'deleteUnassigned'
    | 'sumTotals'
    | 'openLocks'
    | 'weeklyHours'
    | 'internalMembers'
    | 'userOf'
    | 'projectExists'
    | 'titles'
  >;
  readonly timeLogs: Pick<WorkTimeLogsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  /** The member list with custom-role capabilities (52-03's holder query, reused as is). */
  readonly holders: Pick<TimeLocksRepository, 'financeCandidates'>;
  readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly audit: Pick<AuditService, 'record'>;
  /**
   * FIX-2026-11-10 (review M5): files silent automatic sessions before a week is read, so the
   * timesheet and Team time show the same filed time. Absent in compositions without tracking.
   */
  readonly autoFiler?: Pick<AutoTimeFiler, 'settleStale'> | null;
  readonly now?: () => Date;
}

type Actor = 'member' | 'manager';

/** Audit metadata holds at most 20 items per array: ids in rows of 20. */
const AUDIT_IDS_PER_ROW = 20;
function idChunks(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += AUDIT_IDS_PER_ROW) {
    chunks.push(ids.slice(at, at + AUDIT_IDS_PER_ROW));
  }
  return chunks;
}

/** An entry already on a project is filed only under a task of that project. */
function sameProject(entry: WorkItemTimeLogRow, item: { readonly projectId: string }): void {
  if (entry.projectId !== null && entry.projectId !== item.projectId) {
    throw new ApiError(422, 'validation_failed', 'The entry belongs to another project.', [
      { field: 'workItemId', message: 'must be in the entry’s project' },
    ]);
  }
}

const boundsOf = (sheet: TimesheetRow): WeekBounds => ({
  periodStart: sheet.periodStart,
  periodEnd: sheet.periodEnd,
});

export class TimesheetsService {
  private readonly now: () => Date;

  constructor(private readonly options: TimesheetsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The caller's week; the open row is written on first read. */
  async mine(
    context: TenantContext,
    principal: Principal,
    weekRaw: string | undefined,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    await this.options.autoFiler?.settleStale(context, [context.membershipId]);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const bounds = parseWeek(weekRaw, await repo.weekStart(tx, context), utcDay(at));
      const sheet = await repo.ensure(tx, context, context.membershipId, bounds, at);
      return this.sheetView(tx, context, principal, sheet);
    });
  }

  /** One row per internal member for the week (optionally one member). */
  async team(
    context: TenantContext,
    principal: Principal,
    weekRaw: string | undefined,
    membershipRaw: string | undefined,
  ): Promise<TeamWeekView> {
    this.requireManager(principal);
    const filter = optionalId(membershipRaw, 'membershipId');
    await this.options.autoFiler?.settleStale(context, filter === null ? null : [filter]);
    const today = utcDay(this.now());
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const bounds = parseWeek(weekRaw, await repo.weekStart(r, context), today);
      let members = await repo.internalMembers(r, context);
      if (filter !== null) {
        members = members.filter((m) => m.membershipId === filter);
        if (members.length === 0) throw notFound();
      }
      const ids = members.map((m) => m.membershipId);
      const sheets = new Map(
        (await repo.listForPeriod(r, context, bounds.periodStart)).map((s) => [s.membershipId, s]),
      );
      const entries = await repo.entriesInPeriod(r, context, ids, bounds);
      const locks = await repo.openLocks(r, context, bounds);
      const visible = (e: WorkItemTimeLogRow) => this.manages(principal, context, e.projectId);
      const titles = await repo.titles(
        r,
        context,
        entries.filter(visible).flatMap((e) => (e.workItemId === null ? [] : [e.workItemId])),
      );
      const days = daysOf(bounds).filter((day) => day <= today);
      return {
        ...bounds,
        members: members.map((member) => {
          const own = entries.filter((e) => e.loggedBy === member.membershipId);
          const sheet = sheets.get(member.membershipId) ?? null;
          const byDay = minutesByDay(own);
          const shown = own.filter(visible);
          return {
            membershipId: member.membershipId,
            timesheetId: sheet?.id ?? null,
            state: sheet?.state ?? 'open',
            version: sheet?.version ?? null,
            ...timesheetTotals(own),
            editedByManager: sheet?.editedByManager ?? false,
            missingDays: days.filter((day) => (byDay.get(day) ?? 0) === 0),
            longDays: [...byDay].filter(([, m]) => m > LONG_DAY_MINUTES).map(([day]) => day),
            entries: shown.map((e) => entryView(e, titles, locks)),
            otherProjectsMinutes: timesheetTotals(own.filter((e) => !visible(e))).totalMinutes,
          };
        }),
      };
    });
  }

  /** The batch edit (`PUT …/entries`). */
  async upsertEntries(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const input = record(body);
    const version = parseVersion(input['version']);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const { sheet, actor } = await this.editable(tx, context, principal, id);
      if (sheet.version !== version) throw staleVersion(version, sheet.version);
      const bounds = boundsOf(sheet);
      const lines = parseEntries(input['entries'], bounds);
      const locks = await repo.openLocks(tx, context, bounds);
      const before = await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds, true);
      const byId = new Map(before.map((e) => [e.id, e]));
      const created: string[] = [];
      for (const line of lines) {
        if (isWithinLockedPeriod(line.spentOn, locks)) throw entryLocked();
        if (line.id === null) {
          const target = await this.target(tx, context, principal, actor, line);
          const row = await this.options.timeLogs.create(tx, context, {
            workItemId: target.workItemId,
            projectId: target.projectId,
            loggedBy: sheet.membershipId,
            minutes: line.minutes,
            spentOn: line.spentOn,
            note: line.note,
            ...(line.billable === undefined ? {} : { billable: line.billable }),
            source: 'manual',
          });
          created.push(row.id);
          continue;
        }
        const existing = byId.get(line.id);
        if (existing === undefined) throw notFound();
        if (actor === 'manager' && !this.manages(principal, context, existing.projectId)) {
          throw notFound();
        }
        if (existing.lockedAt !== null || isWithinLockedPeriod(existing.spentOn, locks)) {
          throw entryLocked();
        }
        await repo.updateEntry(
          tx,
          context,
          existing.id,
          {
            minutes: line.minutes,
            spentOn: line.spentOn,
            billable: line.billable ?? existing.billable,
            note: line.note,
          },
          sheet.id,
          context.membershipId,
          at,
        );
      }
      await repo.stampTimesheet(tx, context, created, sheet.id);
      return this.finishEdit(tx, context, principal, sheet, actor, before, at, {
        entries_changed: lines.length,
      });
    });
  }

  /** File unassigned entries of the week under one work item. */
  async move(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const input = record(body);
    const entryIds = parseEntryIds(input['entryIds']);
    const workItemId = optionalId(input['workItemId'], 'workItemId');
    if (workItemId === null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'workItemId', message: 'is required' },
      ]);
    }
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const { sheet, actor } = await this.editable(tx, context, principal, id);
      const item = await this.fileTarget(tx, context, principal, actor, workItemId);
      const bounds = boundsOf(sheet);
      const before = await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds, true);
      const locks = await repo.openLocks(tx, context, bounds);
      for (const entryId of entryIds) {
        sameProject(this.unassignedEntry(principal, context, actor, before, entryId, locks), item);
      }
      const moved = await repo.fileUnder(
        tx,
        context,
        entryIds,
        item,
        sheet.id,
        context.membershipId,
        at,
      );
      if (moved !== entryIds.length) throw entryLocked();
      return this.finishEdit(
        tx,
        context,
        principal,
        sheet,
        actor,
        before,
        at,
        {
          entries_changed: moved,
        },
        entryIds,
      );
    });
  }

  /**
   * Split one unassigned entry (live check B2): `minutes` go to a new entry, filed under
   * `workItemId` (a task the caller may track on) or left unassigned; the rest stays. A timed
   * entry is cut in time too, so the two parts never overlap. Same rules as a move: the sheet must
   * be editable, the entry unlocked and outside a locked period.
   */
  async split(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const input = parseSplit(record(body));
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const { sheet, actor } = await this.editable(tx, context, principal, id);
      const bounds = boundsOf(sheet);
      const before = await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds, true);
      const locks = await repo.openLocks(tx, context, bounds);
      const entry = this.unassignedEntry(principal, context, actor, before, input.entryId, locks);
      if (input.minutes >= entry.minutes) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'minutes', message: 'must leave at least one minute on the entry' },
        ]);
      }
      let target: { readonly workItemId: string | null; readonly projectId: string | null } = {
        workItemId: null,
        projectId: entry.projectId,
      };
      if (input.workItemId !== null) {
        const item = await this.fileTarget(tx, context, principal, actor, input.workItemId);
        sameProject(entry, item);
        target = item;
      }
      const keep = entry.minutes - input.minutes;
      const cut =
        entry.startedAt !== null && entry.endedAt !== null
          ? new Date(Math.min(entry.endedAt.getTime(), entry.startedAt.getTime() + keep * 60_000))
          : null;
      await repo.updateEntry(
        tx,
        context,
        entry.id,
        {
          minutes: keep,
          spentOn: entry.spentOn,
          billable: entry.billable,
          note: entry.note,
          ...(cut === null ? {} : { endedAt: cut }),
        },
        sheet.id,
        context.membershipId,
        at,
      );
      const piece = await this.options.timeLogs.create(tx, context, {
        workItemId: target.workItemId,
        projectId: target.projectId,
        loggedBy: sheet.membershipId,
        minutes: input.minutes,
        spentOn: entry.spentOn,
        note: entry.note,
        ...(target.workItemId === null ? { billable: entry.billable } : {}),
        startedAt: cut,
        endedAt: cut === null ? null : entry.endedAt,
        source: entry.source,
        needsReview: entry.needsReview,
      });
      await repo.stampTimesheet(tx, context, [piece.id], sheet.id);
      return this.finishEdit(
        tx,
        context,
        principal,
        sheet,
        actor,
        before,
        at,
        {
          entries_changed: 2,
          entries_split: 1,
        },
        [entry.id, piece.id],
      );
    });
  }

  /**
   * Delete unassigned entries of the week (live check B2): time the person does not want kept.
   * Entries filed under a task are deleted from that task; locked or approved time stays.
   */
  async deleteUnassigned(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const entryIds = parseEntryIds(record(body)['entryIds']);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const { sheet, actor } = await this.editable(tx, context, principal, id);
      const bounds = boundsOf(sheet);
      const before = await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds, true);
      const locks = await repo.openLocks(tx, context, bounds);
      for (const entryId of entryIds) {
        this.unassignedEntry(principal, context, actor, before, entryId, locks);
      }
      const deleted = await repo.deleteUnassigned(tx, context, entryIds, sheet.membershipId);
      if (deleted !== entryIds.length) throw entryLocked();
      return this.finishEdit(
        tx,
        context,
        principal,
        sheet,
        actor,
        before,
        at,
        {
          entries_deleted: deleted,
        },
        entryIds,
      );
    });
  }

  /** Copy the caller's own entries of another week into this (own, editable) week; no notes. */
  async copyFrom(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const sourceRaw = record(body)['sourceWeek'];
    if (typeof sourceRaw !== 'string' || sourceRaw === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'sourceWeek', message: 'must be an ISO week like 2026-W44' },
      ]);
    }
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const { sheet, actor } = await this.editable(tx, context, principal, id);
      if (actor !== 'member') throw notFound();
      const source = parseWeek(sourceRaw, await repo.weekStart(tx, context), utcDay(at));
      if (source.periodStart === sheet.periodStart) {
        throw new ApiError(422, 'validation_failed', 'Pick another week to copy from.', [
          { field: 'sourceWeek', message: 'must not be the same week' },
        ]);
      }
      const bounds = boundsOf(sheet);
      const offset = dayNumberOf(bounds.periodStart) - dayNumberOf(source.periodStart);
      const locks = await repo.openLocks(tx, context, bounds);
      const before = await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds, true);
      const created: string[] = [];
      let skipped = 0;
      for (const entry of await repo.entriesInPeriod(tx, context, [context.membershipId], source)) {
        const spentOn = shiftDay(entry.spentOn, offset);
        const target = isWithinLockedPeriod(spentOn, locks)
          ? null
          : await this.copyTarget(tx, context, principal, entry);
        if (target === null) {
          skipped += 1;
          continue;
        }
        const row = await this.options.timeLogs.create(tx, context, {
          ...target,
          loggedBy: sheet.membershipId,
          minutes: entry.minutes,
          spentOn,
          note: null,
          billable: entry.billable,
          source: 'manual',
        });
        created.push(row.id);
      }
      await repo.stampTimesheet(tx, context, created, sheet.id);
      return this.finishEdit(tx, context, principal, sheet, actor, before, at, {
        entries_changed: created.length,
        entries_skipped: skipped,
        copied_from: source.periodStart,
      });
    });
  }

  /** Own week: open | changes_requested → submitted; every time manager is told. */
  async submit(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
  ): Promise<TimesheetView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const sheet = await repo.findById(tx, context, id, true);
      if (sheet === null || sheet.membershipId !== context.membershipId) throw notFound();
      if (!MEMBER_EDITABLE.includes(sheet.state)) throw notOpen();
      const totals = await repo.sumTotals(tx, context, sheet.membershipId, boundsOf(sheet));
      await repo.update(
        tx,
        context,
        sheet.id,
        sheet.version,
        { state: 'submitted', submittedAt: at, ...totals },
        at,
      );
      const recipients = capabilityHolders(
        await this.options.holders.financeCandidates(tx, context),
        TIME_MANAGE_ANY,
      ).filter((userId) => userId !== context.userId);
      for (const recipientUserId of recipients) {
        await this.options.notifications.insertForRecipient(tx, context, {
          recipientUserId,
          type: TIMESHEET_SUBMITTED_NOTICE,
          objectType: 'timesheet',
          objectId: sheet.id,
          dedupeKey: `timesheet.submitted:${sheet.id}:${at.getTime()}`,
        });
      }
      await this.record(tx, context, 'timesheet.submitted', sheet, {
        total_minutes: totals.totalMinutes,
        recipients: recipients.length,
      });
      return this.reread(tx, context, principal, sheet.id);
    });
  }

  /** Approve (`approve = true`) or ask for changes with a note; never one's own week. */
  async decide(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
    approve: boolean,
  ): Promise<TimesheetView> {
    this.requireManager(principal);
    const id = pathId(idRaw);
    const note = approve ? null : parseDecisionNote(record(body)['note']);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const sheet = await repo.findById(tx, context, id, true);
      if (sheet === null) throw notFound();
      if (sheet.membershipId === context.membershipId) throw cannotApproveOwn();
      if (sheet.state !== 'submitted') throw notSubmitted();
      const entries = await repo.entriesInPeriod(
        tx,
        context,
        [sheet.membershipId],
        boundsOf(sheet),
      );
      if (
        entries.some((e) => e.projectId !== null && !this.manages(principal, context, e.projectId))
      ) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'time.not_your_projects',
        );
      }
      await repo.update(
        tx,
        context,
        sheet.id,
        sheet.version,
        {
          state: approve ? 'approved' : 'changes_requested',
          decidedBy: context.membershipId,
          decidedAt: at,
          decisionNote: note,
        },
        at,
      );
      const member = await repo.userOf(tx, context, sheet.membershipId);
      if (member !== null && member !== context.userId) {
        await this.options.notifications.insertForRecipient(tx, context, {
          recipientUserId: member,
          type: approve ? TIMESHEET_APPROVED_NOTICE : TIMESHEET_CHANGES_NOTICE,
          objectType: 'timesheet',
          objectId: sheet.id,
          dedupeKey: `timesheet.decided:${sheet.id}:${at.getTime()}`,
        });
      }
      await this.record(
        tx,
        context,
        approve ? 'timesheet.approved' : 'timesheet.changes_requested',
        sheet,
        { member_membership_id: sheet.membershipId },
      );
      return this.reread(tx, context, principal, sheet.id);
    });
  }

  /** CSV of one week: no notes; entries outside the caller's projects as one "other" line. */
  async exportCsv(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
  ): Promise<TimesheetCsv> {
    this.requireManager(principal);
    const id = pathId(idRaw);
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const sheet = await repo.findById(tx, context, id);
      if (sheet === null) throw notFound();
      const entries = await repo.entriesInPeriod(
        tx,
        context,
        [sheet.membershipId],
        boundsOf(sheet),
      );
      const shown = entries.filter((e) => this.manages(principal, context, e.projectId));
      const titles = await repo.titles(
        tx,
        context,
        shown.flatMap((e) => (e.workItemId === null ? [] : [e.workItemId])),
      );
      const rows: (string | number)[][] = shown.map((e) => [
        e.spentOn,
        e.projectId ?? '',
        e.workItemId ?? '',
        e.workItemId === null ? '' : (titles.get(e.workItemId) ?? ''),
        e.minutes,
        e.billable ? 'yes' : 'no',
      ]);
      const other = timesheetTotals(entries.filter((e) => !shown.includes(e))).totalMinutes;
      if (other > 0) rows.push(['', '', '', 'other projects', other, '']);
      await this.record(tx, context, 'timesheet.exported', sheet, { rows: rows.length });
      return {
        filename: `timesheet-${sheet.periodStart}.csv`,
        body: toCsv(
          rows,
          ['date', 'project_id', 'work_item_id', 'work_item', 'minutes', 'billable'],
          {
            bom: true,
          },
        ),
      };
    });
  }

  // ---- shared steps ----

  private requireManager(principal: Principal): void {
    requireInternal(principal);
    if (!principalHoldsCapability(principal, TIME_MANAGE_ANY)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  /** May the caller manage this project's time? A project-less entry is nobody's to manage. */
  private manages(principal: Principal, context: TenantContext, projectId: string | null): boolean {
    if (projectId === null) return false;
    return authorize({
      principal,
      capability: TIME_MANAGE_ANY,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /** A task an entry may be filed under: one the caller may track on (and manage, as a manager). */
  private async fileTarget(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    actor: Actor,
    workItemId: string,
  ): Promise<{ readonly workItemId: string; readonly projectId: string }> {
    const item = await this.options.workItems.findById(tx, context, workItemId);
    if (!item || !mayTrackOnItem(principal, item)) throw notFound();
    if (actor === 'manager' && !this.manages(principal, context, item.projectId)) throw notFound();
    return { workItemId: item.id, projectId: item.projectId };
  }

  /**
   * One entry of the sheet the timesheet may change: still unassigned, unlocked, outside a locked
   * period, and (for a manager) on a project they manage. Anything else is refused.
   */
  private unassignedEntry(
    principal: Principal,
    context: TenantContext,
    actor: Actor,
    entries: readonly WorkItemTimeLogRow[],
    entryId: string,
    locks: readonly LockedPeriod[],
  ): WorkItemTimeLogRow {
    const entry = entries.find((e) => e.id === entryId);
    if (entry === undefined) throw notFound();
    if (actor === 'manager' && !this.manages(principal, context, entry.projectId)) throw notFound();
    if (entry.workItemId !== null) throw notUnassigned();
    if (entry.lockedAt !== null || isWithinLockedPeriod(entry.spentOn, locks)) throw entryLocked();
    return entry;
  }

  /**
   * The sheet under a row lock, and who is editing it: its member (open | changes_requested), or a
   * time manager (anything but approved). Anybody else gets the 404 an absent sheet gives.
   */
  private async editable(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<{ readonly sheet: TimesheetRow; readonly actor: Actor }> {
    const sheet = await this.options.repository.findById(tx, context, id, true);
    if (sheet === null) throw notFound();
    if (sheet.membershipId === context.membershipId) {
      if (!MEMBER_EDITABLE.includes(sheet.state)) throw notOpen();
      return { sheet, actor: 'member' };
    }
    if (!principalHoldsCapability(principal, TIME_MANAGE_ANY)) throw notFound();
    if (sheet.state === 'approved') throw notOpen();
    return { sheet, actor: 'manager' };
  }

  /** Where a new line goes: a trackable item (its project), a trackable project, or unsorted. */
  private async target(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    actor: Actor,
    line: EntryInput,
  ): Promise<{ readonly workItemId: string | null; readonly projectId: string | null }> {
    if (line.workItemId !== null) {
      const item = await this.options.workItems.findById(tx, context, line.workItemId);
      if (!item || !mayTrackOnItem(principal, item)) throw notFound();
      if (line.projectId !== null && line.projectId !== item.projectId) {
        throw new ApiError(422, 'validation_failed', 'The request body is invalid', [
          { field: 'projectId', message: 'must be the work item’s project' },
        ]);
      }
      if (actor === 'manager' && !this.manages(principal, context, item.projectId)) {
        throw notFound();
      }
      return { workItemId: item.id, projectId: item.projectId };
    }
    if (line.projectId !== null) {
      if (
        !mayTrackOnProject(principal, context, line.projectId) ||
        !(await this.options.repository.projectExists(tx, context, line.projectId)) ||
        (actor === 'manager' && !this.manages(principal, context, line.projectId))
      ) {
        throw notFound();
      }
      return { workItemId: null, projectId: line.projectId };
    }
    if (actor === 'manager') throw notFound();
    return { workItemId: null, projectId: null };
  }

  /** Where a copied entry goes, or `null` when the caller may no longer track there. */
  private async copyTarget(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    entry: WorkItemTimeLogRow,
  ): Promise<{ readonly workItemId: string | null; readonly projectId: string | null } | null> {
    if (entry.workItemId !== null) {
      const item = await this.options.workItems.findById(tx, context, entry.workItemId);
      return item && mayTrackOnItem(principal, item)
        ? { workItemId: item.id, projectId: item.projectId }
        : null;
    }
    if (entry.projectId !== null) {
      return mayTrackOnProject(principal, context, entry.projectId)
        ? { workItemId: null, projectId: entry.projectId }
        : null;
    }
    return { workItemId: null, projectId: null };
  }

  /**
   * The tail of every edit: 24 h per day, totals re-summed, version moved on (and the manager
   * flag), one audit row with the minutes before and after.
   */
  private async finishEdit(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    sheet: TimesheetRow,
    actor: Actor,
    before: readonly WorkItemTimeLogRow[],
    at: Date,
    facts: Record<string, string | number>,
    /** The entries this edit changed; named in the audit row, 20 per row (the metadata limit). */
    entryIds: readonly string[] = [],
  ): Promise<TimesheetView> {
    const repo = this.options.repository;
    const bounds = boundsOf(sheet);
    const day = overflowingDay(
      await repo.entriesInPeriod(tx, context, [sheet.membershipId], bounds),
    );
    if (day !== null) throw dayOverflow(day);
    const totals = await repo.sumTotals(tx, context, sheet.membershipId, bounds);
    const changed = await repo.update(
      tx,
      context,
      sheet.id,
      sheet.version,
      { ...totals, ...(actor === 'manager' ? { editedByManager: true } : {}) },
      at,
    );
    if (changed === 0) throw staleVersion(sheet.version, sheet.version + 1);
    const chunks = idChunks(entryIds);
    await this.record(tx, context, 'timesheet.entries_edited', sheet, {
      before_minutes: timesheetTotals(before).totalMinutes,
      after_minutes: totals.totalMinutes,
      ...facts,
      ...(actor === 'manager' ? { edited_for_membership_id: sheet.membershipId } : {}),
      ...(chunks.length > 0 ? { entry_ids: chunks[0]! } : {}),
      ...(chunks.length > 1 ? { entry_id_rows: chunks.length } : {}),
    });
    // A batch over 20 entries: the rest of the ids, in follow-up rows of the same action.
    for (let part = 1; part < chunks.length; part += 1) {
      await this.record(tx, context, 'timesheet.entries_edited', sheet, {
        entry_ids: chunks[part]!,
        entry_id_row: part + 1,
      });
    }
    return this.reread(tx, context, principal, sheet.id);
  }

  private async reread(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<TimesheetView> {
    const sheet = await this.options.repository.findById(tx, context, id);
    if (sheet === null) throw new Error('timesheet vanished after it was written');
    return this.sheetView(tx, context, principal, sheet);
  }

  /** One week as its member sees it; a manager sees other projects collapsed. */
  private async sheetView(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    sheet: TimesheetRow,
  ): Promise<TimesheetView> {
    const repo = this.options.repository;
    const bounds = boundsOf(sheet);
    const own = sheet.membershipId === context.membershipId;
    const entries = await repo.entriesInPeriod(runner, context, [sheet.membershipId], bounds);
    const locks = await repo.openLocks(runner, context, bounds);
    const shown = own
      ? entries
      : entries.filter((e) => this.manages(principal, context, e.projectId));
    const titles = await repo.titles(
      runner,
      context,
      shown.flatMap((e) => (e.workItemId === null ? [] : [e.workItemId])),
    );
    const hours = await repo.weeklyHours(runner, context, sheet.membershipId);
    const groups = new Map<string, TimesheetEntryView[]>();
    for (const entry of shown) {
      const key = `${entry.projectId ?? ''}|${entry.workItemId ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(entryView(entry, titles, locks));
      groups.set(key, list);
    }
    return {
      id: sheet.id,
      membershipId: sheet.membershipId,
      ...bounds,
      days: daysOf(bounds),
      state: sheet.state,
      version: sheet.version,
      submittedAt: sheet.submittedAt?.toISOString() ?? null,
      decidedAt: sheet.decidedAt?.toISOString() ?? null,
      decisionNote:
        own || principalHoldsCapability(principal, TIME_MANAGE_ANY) ? sheet.decisionNote : null,
      editedByManager: sheet.editedByManager,
      ...timesheetTotals(entries),
      capacityMinutes: hours === null ? null : hours * 60,
      locked: daysOf(bounds).some((day) => isWithinLockedPeriod(day, locks)),
      needsReview: shown.filter((e) => e.needsReview).length,
      groups: [...groups.values()].map((list) => ({
        projectId: list[0]?.projectId ?? null,
        workItemId: list[0]?.workItemId ?? null,
        title: list[0]?.title ?? null,
        minutes: timesheetTotals(list).totalMinutes,
        entries: list,
      })),
      otherProjectsMinutes: timesheetTotals(entries.filter((e) => !shown.includes(e))).totalMinutes,
    };
  }

  private record(
    tx: TenantQueryRunner,
    context: TenantContext,
    action:
      | 'timesheet.entries_edited'
      | 'timesheet.submitted'
      | 'timesheet.approved'
      | 'timesheet.changes_requested'
      | 'timesheet.exported',
    sheet: TimesheetRow,
    facts: Record<string, string | number | readonly string[]>,
  ): Promise<unknown> {
    return this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId: sheet.id,
      actorUserId: context.userId,
      metadata: { period_start: sheet.periodStart, ...facts },
    });
  }
}

function minutesByDay(entries: readonly WorkItemTimeLogRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.spentOn, (out.get(e.spentOn) ?? 0) + e.minutes);
  return out;
}

function entryView(
  row: WorkItemTimeLogRow,
  titles: ReadonlyMap<string, string>,
  locks: readonly LockedPeriod[],
): TimesheetEntryView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    projectId: row.projectId,
    title: row.workItemId === null ? null : (titles.get(row.workItemId) ?? null),
    spentOn: row.spentOn,
    minutes: row.minutes,
    billable: row.billable,
    note: row.note ?? null,
    needsReview: row.needsReview,
    locked: row.lockedAt !== null || isWithinLockedPeriod(row.spentOn, locks),
    source: row.source,
  };
}
