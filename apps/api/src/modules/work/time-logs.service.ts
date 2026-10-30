import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkTimeLogsRepository } from './time-logs.repository.js';

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
}

/** The list response: the entries and their summed total minutes for this item. */
export interface TimeLogListView {
  readonly entries: readonly TimeLogView[];
  readonly totalMinutes: number;
}

export interface AddTimeLogInput {
  readonly minutes: number;
  readonly spentOn: string;
  readonly note: string | null;
  /**
   * 52-01. When the entry was worked, both or neither, already bounded to the last 31 days by the
   * controller (`parseManualSpan`). Stored with `source = 'manual'`.
   */
  readonly startedAt?: Date | null;
  readonly endedAt?: Date | null;
  /** 52-01. Default true. */
  readonly billable?: boolean;
}

export class WorkTimeLogsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly timeLogs: WorkTimeLogsRepository = new WorkTimeLogsRepository(),
    /** 52-01. `time_log.created` on every entry; optional until `work.module.ts` passes it. */
    private readonly audit: Pick<AuditService, 'record'> | null = null,
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
      const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
      return { entries, totalMinutes };
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
      const row = await this.timeLogs.create(tx, context, {
        workItemId,
        projectId: parent.projectId,
        loggedBy: principal.membershipId,
        minutes: input.minutes,
        spentOn: input.spentOn,
        note: input.note,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        billable: input.billable ?? true,
        source: 'manual',
      });
      if (this.audit) {
        await this.audit.record(tx, context, {
          action: 'time_log.created',
          result: 'allowed',
          objectId: row.id,
          actorUserId: context.userId,
          metadata: {},
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

      await this.timeLogs.remove(tx, context, workItemId, entryId);
    });
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
  };
}
