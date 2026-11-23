import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, users, workItemComments } from '../../common/database/schema.js';
import type { WorkItemCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item comments — x147's storage half (Work module 7).
 *
 * Follows `WorkItemsRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite
 * foreign key of migration 0053 is what makes a cross-tenant `work_item_id` a non-existent pair.
 *
 * A comment is append-only: this repository inserts and reads, and offers no update or delete —
 * the missing methods mirror the withheld privilege in `users.sql` and the 0053 trigger.
 */

/** The largest comment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_COMMENT_PAGE = 500;

export interface CreateCommentInput {
  readonly workItemId: string;
  readonly authorMembershipId: string;
  readonly body: string;
}

/** Who wrote a comment: the author membership's person, read through this tenant only. */
export interface CommentAuthorRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

export class WorkCommentsRepository {
  /**
   * The people behind these author memberships (W-WEB-1 leftover: comments show their author).
   * Anchored on this tenant's own `memberships` rows, so `users` (global identity) is reached
   * only through a membership of this organization — the `DocumentSharingRepository.people`
   * pattern. A membership of another tenant, or one that is gone, simply does not resolve.
   */
  async authors(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<readonly CommentAuthorRow[]> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, context.organizationId), inArray(memberships.id, ids)),
      );
  }

  /** One comment, scoped to the tenant and its parent work item; `null` if absent. */
  async findComment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    commentId: string,
  ): Promise<WorkItemCommentRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemComments)
      .where(
        and(
          eq(workItemComments.organizationId, context.organizationId),
          eq(workItemComments.workItemId, workItemId),
          eq(workItemComments.id, commentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The work item's comments, created-at ascending then id, bounded to one page. */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_COMMENT_PAGE,
  ): Promise<readonly WorkItemCommentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemComments)
      .where(
        and(
          eq(workItemComments.organizationId, context.organizationId),
          eq(workItemComments.workItemId, workItemId),
          // PA-03 (0245): a soft-deleted comment leaves the list.
          isNull(workItemComments.deletedAt),
        ),
      )
      .orderBy(asc(workItemComments.createdAt), asc(workItemComments.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_COMMENT_PAGE));
  }

  /** Append a comment. The server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateCommentInput,
  ): Promise<WorkItemCommentRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(workItemComments)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        authorMembershipId: input.authorMembershipId,
        body: input.body,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findComment(runner, context, input.workItemId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('work item comment vanished immediately after insert');
    }
    return created;
  }
}
