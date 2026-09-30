import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkItemSubtaskRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkSubtasksRepository } from './subtasks.repository.js';

/**
 * x307's application service — a work item's ordered subtasks / breakdown (Work module).
 *
 * It is `WorkChecklistService`'s shape: the repository stays free of policy, the controller free of
 * both, and the two rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether this
 * principal may act on it, judged against the work item's own project and audience. A cross-tenant
 * (or unrelated) parent is a 404 with no write, never a row created against somebody else's work.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * A subtask has no audience of its own; it inherits the parent work item's. The read gate is
 * `work.read` on that item; the write gate is `work.update`. A caller who may read the item but not
 * update it gets a 403 (their access to the item is not a secret); a caller with no relation to the
 * item at all gets a 404 (its existence is).
 *
 * ## The roll-up is a count, not a state machine
 *
 * `list` returns the subtasks plus a read-only `{ done, total }` roll-up the detail screen renders
 * as a progress bar. It never transitions the parent — there is no state machine here.
 */

/** The client-facing projection of one subtask. Paired in `e2e/contracts`. */
export interface WorkSubtaskView {
  readonly id: string;
  readonly workItemId: string;
  readonly title: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
}

/** The subtask list plus the parent's done/total roll-up. Paired in `e2e/contracts`. */
export interface WorkSubtaskListView {
  readonly items: readonly WorkSubtaskView[];
  readonly done: number;
  readonly total: number;
}

export interface AddSubtaskInput {
  readonly title: string;
}

export interface UpdateSubtaskInput {
  readonly title?: string;
  readonly done?: boolean;
  readonly position?: number;
}

export class WorkSubtasksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly subtasks: WorkSubtasksRepository = new WorkSubtasksRepository(),
  ) {}

  /**
   * The work item's subtasks, position ascending, plus the `{ done, total }` roll-up. Behind
   * `work.read` on the parent item.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkSubtaskListView> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.subtasks.listForWorkItem(runner, context, workItemId);
      const items = rows.map(toView);
      return { items, done: items.filter((item) => item.done).length, total: items.length };
    });
  }

  /** Append a subtask. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddSubtaskInput,
  ): Promise<WorkSubtaskView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.subtasks.create(tx, context, {
        parentWorkItemId: workItemId,
        title: input.title,
        createdBy: context.userId,
      });
      return toView(row);
    });
  }

  /** Move `title`, `done` and/or `position` in place, idempotently. Behind `work.update`. */
  async update(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    subtaskId: string,
    input: UpdateSubtaskInput,
  ): Promise<WorkSubtaskView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The subtask is resolved scoped to the tenant and its parent; a cross-tenant `subtaskId`, or
      // one belonging to another work item, does not resolve and is the same 404 as an absent id —
      // no write is attempted against it.
      const existing = await this.subtasks.findSubtask(tx, context, workItemId, subtaskId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const row = await this.subtasks.update(tx, context, workItemId, subtaskId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.done === undefined ? {} : { isDone: input.done }),
        ...(input.position === undefined ? {} : { position: input.position }),
      });
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return toView(row);
    });
  }

  /** Remove a subtask by id. Behind `work.update` on the parent item. */
  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    subtaskId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // A subtask id that names another item's row (or another tenant's) does not resolve and is the
      // same 404 an absent id gives — no delete is attempted against it.
      const existing = await this.subtasks.findSubtask(tx, context, workItemId, subtaskId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      await this.subtasks.deleteSubtask(tx, context, workItemId, subtaskId);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist — so a caller cannot discover an item by trying to hang
   * a subtask off it.
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
      // Forbidden rather than not-found: the caller has already been allowed to read this item, so
      // its existence is not a secret from them.
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

function toView(row: WorkItemSubtaskRow): WorkSubtaskView {
  return {
    id: row.id,
    workItemId: row.parentWorkItemId,
    title: row.title,
    done: row.isDone,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}
