import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { WorkItemRow, WorkItemReminderRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemRemindersRepository } from './item-reminders.repository.js';
import type { DueReminderWithItem } from './item-reminders.repository.js';

/**
 * x256's application service — a personal reminder on a work item (Work module 7).
 *
 * It is `WorkWatchersService`'s shape with a mutable payload: the repository stays free of policy,
 * the controller stays free of both, and the rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * The set and clear routes name a `workItemId` in the path. The parent work item is read first,
 * scoped to the acting tenant — a `work_item_id` from another studio simply does not resolve, and
 * the answer is the same 404 an absent id gives. Only once the row is in hand is `authorize()`
 * asked whether this principal may *read* it. That order is the trap x256 was briefed on: a
 * cross-tenant (or unrelated) parent is a 404 with no upsert, never a reminder written against
 * somebody else's work.
 *
 * ## `work.read` is the whole gate; a caller reminds only themselves
 *
 * A reminder is self-service. The capability is `work.read` on the item (the coarse check is on
 * the controller); the row-level decision — may this principal see *this* item — is `authorize()`'s,
 * against the item's own project and audience. A caller who may read the item may set and clear
 * their own reminder; there is no route to set anyone else's, so the acting membership is always
 * the subject. The due list is the acting member's own reminders and nothing else. **No
 * notification is dispatched here** — email/dispatch is a separate, out-of-scope path.
 *
 * ## `remindAt` is a bound instant
 *
 * The controller parses `remindAt` to a `Date` (a 400 if it is not a valid instant) and this
 * service persists that bound value; the due read compares against a bound `before` the controller
 * parsed the same way. Neither instant is the connection's `CURRENT_TIMESTAMP`, so the behaviour
 * does not depend on which pool's clock ran the statement.
 */

/**
 * The client-facing projection of one reminder. Paired `Exact` with the web `WorkItemReminder` in
 * `e2e/contracts`. `membershipId` is a membership id, never an email or a raw user id.
 */
export interface WorkItemReminderView {
  readonly id: string;
  readonly workItemId: string;
  readonly membershipId: string;
  readonly remindAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One entry in the "My Reminders" due list — a reminder joined to the item it names, so the screen
 * can render a title and state. Paired `Exact` with the web `DueReminder` in `e2e/contracts`.
 */
export interface DueReminderView {
  readonly id: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  readonly membershipId: string;
  readonly remindAt: string;
}

export class WorkItemRemindersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly reminders: WorkItemRemindersRepository = new WorkItemRemindersRepository(),
  ) {}

  /**
   * Set (or move) the acting member's reminder on the item. Idempotent by the unique
   * `(org, item, member)` key — a second call moves `remind_at` rather than duplicating. Behind
   * `work.read` on the parent item.
   */
  async set(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    remindAt: Date,
  ): Promise<WorkItemReminderView> {
    return this.database.transaction(context, async (tx) => {
      await this.readableParent(tx, context, principal, workItemId);
      const membershipId = this.actingMember(principal);
      const row = await this.reminders.upsert(tx, context, { workItemId, membershipId, remindAt });
      return toView(row);
    });
  }

  /**
   * Clear the acting member's reminder on the item. Idempotent: clearing an absent reminder is a
   * no-op, so a repeated clear still succeeds. Behind `work.read` on the parent item.
   */
  async clear(context: TenantContext, principal: Principal, workItemId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.readableParent(tx, context, principal, workItemId);
      const membershipId = this.actingMember(principal);
      await this.reminders.deleteForMember(tx, context, workItemId, membershipId);
    });
  }

  /**
   * The acting member's reminders due at or before `before`, soonest first. Own reminders only —
   * there is no route to another member's list. Behind `work.read` (the coarse controller gate).
   *
   * F57: owning the reminder row is not current read authority over the item. Each joined item is
   * re-authorized (`work.read` on its own project and audience) and a soft-deleted one dropped, the
   * way `readableParent` and `ProjectFavoritesService.list` do — so a member removed from a project,
   * or whose item moved or was deleted, no longer sees its live title and state here.
   */
  async listDue(
    context: TenantContext,
    principal: Principal,
    before: Date,
  ): Promise<readonly DueReminderView[]> {
    return this.database.read(context, async (runner) => {
      const membershipId = this.actingMember(principal);
      const rows = await this.reminders.listDueForMember(runner, context, membershipId, before);
      return rows
        .filter((row) => row.workItem.deletedAt === null && this.mayRead(principal, row.workItem))
        .map(toDueView);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it with the
   * same 404 a missing item gives — so a caller cannot discover an item by setting a reminder on it.
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
   * identity to remind, and there is no route to remind anyone else — so this is a 403.
   */
  private actingMember(principal: Principal): string {
    const membershipId = principal.membershipId;
    if (!membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    return membershipId;
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

function toView(row: WorkItemReminderRow): WorkItemReminderView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    membershipId: row.membershipId,
    remindAt: row.remindAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDueView(joined: DueReminderWithItem): DueReminderView {
  return {
    id: joined.reminder.id,
    workItemId: joined.reminder.workItemId,
    workItemTitle: joined.workItemTitle,
    workItemState: joined.workItemState,
    membershipId: joined.reminder.membershipId,
    remindAt: joined.reminder.remindAt.toISOString(),
  };
}
