import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  WorkItemChecklistItemRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkChecklistRepository } from './work-checklist.repository.js';

/**
 * x145's application service — the checklist / sub-items behind a work item (Work module 7).
 *
 * It is `WorkItemsService`'s shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the two rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path. The parent work item is read first, scoped to
 * the acting tenant — a `work_item_id` from another studio simply does not resolve, and the
 * answer is the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked
 * whether this principal may act on it, judged against the work item's own project and audience.
 * That order is the trap x145 was briefed on: a cross-tenant (or unrelated) parent is a 404 with
 * no write, never a row created against somebody else's work.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * A checklist item has no audience of its own; it inherits the parent work item's. The read gate
 * is `work.read` on that item; the write gate is `work.update`. A caller who may read the item
 * but not update it gets a 403 (their access to the item is not a secret); a caller with no
 * relation to the item at all gets a 404 (its existence is).
 */

/** The client-facing projection of one checklist item. Paired in `e2e/contracts`. */
export interface WorkChecklistItemView {
  readonly id: string;
  readonly workItemId: string;
  readonly label: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
}

export interface AddChecklistItemInput {
  readonly label: string;
}

export interface UpdateChecklistItemInput {
  readonly label?: string;
  readonly done?: boolean;
}

export class WorkChecklistService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly checklist: WorkChecklistRepository = new WorkChecklistRepository(),
  ) {}

  /** The work item's checklist, position ascending. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkChecklistItemView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.checklist.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /** Append a checklist item. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddChecklistItemInput,
  ): Promise<WorkChecklistItemView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.checklist.create(tx, context, { workItemId, label: input.label });
      return toView(row);
    });
  }

  /** Toggle `done` and/or rename `label`. Behind `work.update` on the parent item. */
  async update(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
  ): Promise<WorkChecklistItemView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The item is resolved scoped to the tenant and its parent; a cross-tenant `itemId`, or one
      // belonging to another work item, does not resolve and is the same 404 as an absent id — no
      // write is attempted against it.
      const existing = await this.checklist.findItem(tx, context, workItemId, itemId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const row = await this.checklist.update(tx, context, workItemId, itemId, input);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return toView(row);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404
   * for "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist — so a caller cannot discover an item by trying to
   * hang a checklist off it.
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
      // Forbidden rather than not-found: the caller has already been allowed to read this item,
      // so its existence is not a secret from them.
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

function toView(row: WorkItemChecklistItemRow): WorkChecklistItemView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    label: row.label,
    done: row.done,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}
