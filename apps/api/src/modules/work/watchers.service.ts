import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { WorkItemRow, WorkItemWatcherRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkWatchersRepository } from './watchers.repository.js';

/**
 * x232's application service — a work item's watchers / subscribers (Work module 7).
 *
 * It is `WorkCommentsService`'s shape: the repository stays free of policy, the controller stays
 * free of both, and the rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether
 * this principal may *read* it. That order is the trap x232 was briefed on: a cross-tenant (or
 * unrelated) parent is a 404 with no write, never a subscription against somebody else's work.
 *
 * ## `work.read` is the whole gate; a caller watches only themselves
 *
 * A watch is self-service. The capability is `work.read` on the item (the coarse check is on the
 * controller); the row-level decision — may this principal see *this* item — is `authorize()`'s,
 * against the item's own project and audience. A caller who may read the item may subscribe
 * themselves to it and unsubscribe themselves; there is no route to subscribe anyone else, so the
 * acting membership is always the subject. No notification is dispatched here — that path is the
 * notifications module and a later slice's work.
 */

/**
 * The client-facing projection of one watcher. Paired `Exact` with the web `ItemWatcher` in
 * `e2e/contracts`. `memberId` is a membership id, never an email or a raw user id — the list is a
 * roster of who is watching, not a contact sheet.
 */
export interface ItemWatcherView {
  readonly id: string;
  readonly workItemId: string;
  readonly memberId: string;
  readonly createdAt: string;
}

export class WorkWatchersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly watchers: WorkWatchersRepository = new WorkWatchersRepository(),
  ) {}

  /** The item's watchers, oldest first. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly ItemWatcherView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.watchers.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /**
   * Subscribe the acting membership to the item. Idempotent: a second subscribe returns the
   * existing row rather than duplicating it (the unique `(org, item, member)` key). Behind
   * `work.read` on the parent item.
   */
  async subscribe(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<ItemWatcherView> {
    return this.database.transaction(context, async (tx) => {
      await this.readableParent(tx, context, principal, workItemId);
      const memberId = this.actingMember(principal);
      const existing = await this.watchers.findForMember(tx, context, workItemId, memberId);
      if (existing) {
        return toView(existing);
      }
      const row = await this.watchers.create(tx, context, { workItemId, memberId });
      return toView(row);
    });
  }

  /**
   * Unsubscribe the acting membership from the item. Idempotent: removing an absent watch is a
   * no-op, so a repeated unsubscribe still succeeds. Behind `work.read` on the parent item.
   */
  async unsubscribe(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.readableParent(tx, context, principal, workItemId);
      const memberId = this.actingMember(principal);
      await this.watchers.deleteForMember(tx, context, workItemId, memberId);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it with the
   * same 404 a missing item gives — so a caller cannot discover an item by trying to watch it.
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

  /**
   * The acting membership id. A `work.read` holder who reached a readable item is an internal
   * member of this studio, so a membership id is present; a principal without one has no member
   * identity to watch as, and there is no route to watch anyone else — so this is a 403.
   */
  private actingMember(principal: Principal): string {
    const memberId = principal.membershipId;
    if (!memberId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    return memberId;
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

function toView(row: WorkItemWatcherRow): ItemWatcherView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    memberId: row.memberId,
    createdAt: row.createdAt.toISOString(),
  };
}
