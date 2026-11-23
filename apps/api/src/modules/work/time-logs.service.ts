import { authorize, localDateOf, timeTrustOf } from '@tmanage/domain';
import type { Principal, TimeApprovalState, TimeTrust } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { companyTimeZone } from '../tenancy/auto-time-tracking-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkTimeLogsRepository } from './time-logs.repository.js';
import {
  handEntryState,
  readTimeTrustPolicy,
  requireHandTimeAllowed,
} from '../time/time-trust-rules.js';
import type { TimeLogSource } from '../time/time-rules.js';

/**
 * x231's application service — logged effort per work item (Work module 7).
 *
 * The checklist service's shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether this
 * principal may act on it, judged against the work item's own project and audience. A cross-tenant
 * (or unrelated) parent is a 404 with no write, never a row created against somebody else's work.
 *
 * ## `authorize()` gates read and write; the author gates their own delete
 *
 * A time-log entry has no audience of its own; it inherits the parent work item's. The read gate is
 * `work.read` on that item; the write gate is `work.update`. Delete additionally requires that the
 * caller is the entry's own author (`logged_by`) — a member with `work.update` may log and list, but
 * may only remove entries they recorded themselves.
 */

/** The client-facing projection of one time-log entry. Paired in `e2e/contracts`. */
export interface TimeLogView {
  readonly id: string;
  readonly workItemId: string;
  readonly loggedBy: string;
  readonly minutes: number;
  readonly spentOn: string;
  readonly note: string | null;
  readonly createdAt: string;
  /** 2026-11-23 time trust: how the minutes came in and whether they count yet. */
  readonly source: TimeLogSource;
  readonly trust: TimeTrust;
  readonly approvalState: TimeApprovalState;
  readonly counted: boolean;
  readonly reason: string | null;
}

/** The list response: the entries and their summed total minutes for this item. */
export interface TimeLogListView {
  readonly entries: readonly TimeLogView[];
  /** The minutes that count (measured, approved, or flagged hand time when the owner allows it). */
  readonly totalMinutes: number;
  /** Hand-added or corrected minutes still waiting for a manager (not in `totalMinutes`). */
  readonly pendingMinutes: number;
}

export interface AddTimeLogInput {
  readonly minutes: number;
  /** `null` with a span: the company-calendar day (`default_timezone`) `startedAt` falls on. */
  readonly spentOn: string | null;
  readonly note: string | null;
  /**
   * 52-01. When the entry was worked, both or neither, already bounded to the last 31 days by the
   * controller (`parseManualSpan`). Stored with `source = 'manual'`.
   */
  readonly startedAt?: Date | null;
  readonly endedAt?: Date | null;
  /** 52-01. Absent = the work item's `billable`, else the project's `billable_default` (52-04). */
  readonly billable?: boolean;
  /** 2026-11-23: why the time is typed in; required while the owner allows hand time. */
  readonly reason?: string | null;
}

export class WorkTimeLogsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly timeLogs: WorkTimeLogsRepository = new WorkTimeLogsRepository(),
    /** 52-01. `time_log.created` on every entry; optional until `work.module.ts` passes it. */
    private readonly audit: Pick<AuditService, 'record'> | null = null,
    /** 52-01. The company time zone a span's day is read in. */
    private readonly settings: Pick<
      OrgSettingsRepository,
      'findByKey'
    > = new OrgSettingsRepository(),
  ) {}

  /** The work item's time-log entries plus a summed total. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<TimeLogListView> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.timeLogs.listForWorkItem(runner, context, workItemId);
      const entries = rows.map((row) => toView(row, workItemId));
      const totalMinutes = entries.reduce((sum, e) => sum + (e.counted ? e.minutes : 0), 0);
      const pendingMinutes = entries.reduce(
        (sum, e) => sum + (!e.counted && e.approvalState === 'pending' ? e.minutes : 0),
        0,
      );
      return { entries, totalMinutes, pendingMinutes };
    });
  }

  /** Log an effort entry. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddTimeLogInput,
  ): Promise<TimeLogView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      if (principal.kind !== 'internal') {
        // 52-01. Time is internal: a client principal with `work.update` still logs nothing.
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'time.internal_only');
      }
      // 2026-11-23 time trust: typed-in minutes only when the owner allows them, with a reason;
      // they wait for a manager (or count at once, flagged, when the owner chose that).
      const policy = await readTimeTrustPolicy(tx, context, this.settings);
      const reason = requireHandTimeAllowed(policy, input.reason ?? null);
      const state = handEntryState(policy.handTimeCountMode);
      // FIX-2026-11-10 (review L3): the same hour is never counted twice. Automatic filing skips
      // time a timed entry already covers; a manual timed entry over automatic time is refused.
      if (
        input.startedAt &&
        input.endedAt &&
        (await this.timeLogs.automaticOverlaps(
          tx,
          context,
          principal.membershipId,
          input.startedAt,
          input.endedAt,
        ))
      ) {
        throw new ApiError(
          409,
          'conflict',
          'This time overlaps time your computer already recorded automatically. Choose another time, or edit the automatic entry in your timesheet.',
          [{ field: 'startedAt', message: 'overlaps_automatic_time' }],
        );
      }
      const spentOn = await this.dayOf(tx, context, input);
      const today = localDateOf(new Date(), await companyTimeZone(tx, context, this.settings));
      if (spentOn > today) {
        throw new ApiError(
          400,
          'validation_failed',
          'Time cannot be added for a day still ahead.',
          [{ field: 'spentOn', message: 'future_day' }],
        );
      }
      const row = await this.timeLogs.create(tx, context, {
        workItemId,
        projectId: parent.projectId,
        loggedBy: principal.membershipId,
        minutes: input.minutes,
        spentOn,
        note: input.note,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        // 52-04: absent = the work item's flag, else the project's default (repository).
        ...(input.billable === undefined ? {} : { billable: input.billable }),
        // The repository fills rate_snapshot_minor / cost_snapshot_minor from the rate cards.
        source: 'manual',
        approvalState: state.approvalState,
        counted: state.counted,
        reason,
      });
      if (this.audit) {
        await this.audit.record(tx, context, {
          action: 'time_log.created',
          result: 'allowed',
          objectId: row.id,
          actorUserId: context.userId,
          metadata: { source: 'manual', approval_state: state.approvalState },
          changes: [
            { field: 'minutes', before: null, after: String(row.minutes) },
            { field: 'spent_on', before: null, after: row.spentOn },
          ],
        });
      }
      return toView(row, workItemId);
    });
  }

  /**
   * Delete a time-log entry. Behind `work.update` on the parent item, and only the entry's own
   * author may remove it: a cross-tenant or unrelated entry is a 404 (resolved before authorize);
   * an entry authored by someone else is a 403.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    entryId: string,
  ): Promise<void> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      const existing = await this.timeLogs.findEntry(tx, context, workItemId, entryId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      if (existing.loggedBy !== principal.membershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }
      if (existing.lockedAt instanceof Date) {
        // 52-01 (0265). A locked period (52-03) keeps its entries; delete is refused like edit.
        throw new ApiError(409, 'conflict', 'This entry is in a locked period.', [
          { field: 'lockedAt', message: 'time_log_locked' },
        ]);
      }

      if (existing.approvalState === 'approved') {
        // 2026-11-23 time trust: approved time is part of what a manager accepted; only a
        // manager removes it (from the timesheet), never its author alone.
        throw new ApiError(
          403,
          'forbidden',
          'Approved time can only be removed by a manager.',
          [{ field: 'approvalState', message: 'approved_time' }],
          'time.approved_delete',
        );
      }

      await this.timeLogs.remove(tx, context, workItemId, entryId);
      if (this.audit) {
        await this.audit.record(tx, context, {
          action: 'time_log.deleted',
          result: 'allowed',
          objectId: existing.id,
          actorUserId: context.userId,
          metadata: { source: existing.source, approval_state: existing.approvalState },
          changes: [
            { field: 'minutes', before: String(existing.minutes), after: null },
            { field: 'spent_on', before: existing.spentOn, after: null },
          ],
        });
      }
    });
  }

  /** The entry's day: the typed one, else the company-calendar day its span started on. */
  private async dayOf(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: AddTimeLogInput,
  ): Promise<string> {
    if (input.spentOn !== null) return input.spentOn;
    if (!input.startedAt) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'spentOn', message: 'must be a calendar day in YYYY-MM-DD form' },
      ]);
    }
    return localDateOf(input.startedAt, await companyTimeZone(tx, context, this.settings));
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist.
   */
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

function toView(row: WorkItemTimeLogRow, workItemId: string): TimeLogView {
  return {
    id: row.id,
    workItemId: row.workItemId ?? workItemId,
    loggedBy: row.loggedBy,
    minutes: row.minutes,
    spentOn: row.spentOn,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
    source: row.source,
    trust: timeTrustOf(row.source),
    approvalState: row.approvalState,
    counted: row.counted,
    reason: row.reason ?? null,
  };
}
