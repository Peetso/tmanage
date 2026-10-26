import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemCommentRow, WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { WorkCommentsRepository } from './work-comments.repository.js';

/**
 * x147's application service — a work item's comments / activity (Work module 7).
 *
 * It is `WorkItemsService`'s shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the two rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Both routes name a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether
 * this principal may act on it, judged against the work item's own project and audience. That
 * order is the trap x147 was briefed on: a cross-tenant (or unrelated) parent is a 404 with no
 * write, never a comment created against somebody else's work.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * A comment has no audience of its own; it inherits the parent work item's. The read gate is
 * `work.read` on that item; the write gate is `work.update`. A caller who may read the item but
 * not comment on it gets a 403 (their access to the item is not a secret); a caller with no
 * relation to the item at all gets a 404 (its existence is). A comment is internal-only — it is
 * authored by a membership of the studio and never projected to a client surface.
 */

/** The client-facing projection of one work-item comment. Paired in `e2e/contracts`. */
export interface WorkCommentView {
  readonly id: string;
  readonly workItemId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AddCommentInput {
  readonly body: string;
}

export class WorkCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly comments: WorkCommentsRepository = new WorkCommentsRepository(),
    private readonly audit: AuditEventsRepository = new AuditEventsRepository(),
  ) {}

  /** The work item's comments, created-at ascending. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkCommentView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.comments.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /** Append a comment. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddCommentInput,
  ): Promise<WorkCommentView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The author is the acting membership. A `work.update` holder is always an internal
      // member of this studio, so a membership id is present; a principal without one could not
      // have passed the write gate and there is no client author of an internal comment.
      const authorMembershipId = principal.membershipId;
      if (!authorMembershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }

      const row = await this.comments.create(tx, context, {
        workItemId,
        authorMembershipId,
        body: input.body,
      });
      // A comment written through a connected AI app is attributed to the member AND the app: one
      // audit row on the item (the append stamps channel and app), read back by the activity feed.
      if (context.actorChannel !== undefined) {
        await this.audit.append(tx, context, {
          action: 'work_item.commented',
          result: 'allowed',
          objectId: workItemId,
          metadata: { entry_id: row.id },
        });
      }
      return toView(row);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404
   * for "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist — so a caller cannot discover an item by trying to
   * hang a comment off it.
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

function toView(row: WorkItemCommentRow): WorkCommentView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
