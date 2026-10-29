import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { softDeleteValues } from '../../common/database/content-retention.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { requestComments } from '../../common/database/schema.js';
import type { RequestCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Request comments — x299's storage half (Requests module 11).
 *
 * Follows `WorkCommentsRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite foreign
 * key of migration 0167 is what makes a cross-tenant `request_id` a non-existent pair.
 *
 * A comment is append-with-retract: this repository inserts, reads and deletes, and offers no
 * update — the missing method mirrors the withheld privilege in `users.sql` and the 0167 trigger.
 */

/** The largest comment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_REQUEST_COMMENT_PAGE = 500;

export interface CreateRequestCommentInput {
  readonly requestId: string;
  readonly parentId: string | null;
  readonly authorMembershipId: string;
  readonly body: string;
}

export class RequestCommentsRepository {
  /** One comment, scoped to the tenant and its parent request; `null` if absent. */
  async findComment(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    commentId: string,
  ): Promise<RequestCommentRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(requestComments)
      .where(
        and(
          eq(requestComments.organizationId, context.organizationId),
          eq(requestComments.requestId, requestId),
          eq(requestComments.id, commentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The request's comments, created-at ascending then id, bounded to one page. */
  async listForRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    limit: number = MAX_REQUEST_COMMENT_PAGE,
  ): Promise<readonly RequestCommentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(requestComments)
      .where(
        and(
          eq(requestComments.organizationId, context.organizationId),
          eq(requestComments.requestId, requestId),
          // PA-03 (0245): a soft-deleted comment leaves the list.
          isNull(requestComments.deletedAt),
        ),
      )
      .orderBy(asc(requestComments.createdAt), asc(requestComments.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_REQUEST_COMMENT_PAGE));
  }

  /** Append a comment. The server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateRequestCommentInput,
  ): Promise<RequestCommentRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(requestComments)
      .values({
        id,
        organizationId: context.organizationId,
        requestId: input.requestId,
        parentId: input.parentId,
        authorMembershipId: input.authorMembershipId,
        body: input.body,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findComment(runner, context, input.requestId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('request comment vanished immediately after insert');
    }
    return created;
  }

  /**
   * Delete a comment's direct replies, then the comment itself, within the acting tenant and its
   * parent request. PA-03 (0245): both are soft deletes with one restore window; the worker purges
   * replies before their parent so the RESTRICT self-reference (0167) is never violated.
   */
  async deleteWithReplies(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    commentId: string,
    reason: string | null = null,
  ): Promise<void> {
    const softDelete = await softDeleteValues(runner, context.userId, reason);
    await tenantDrizzle(runner)
      .update(requestComments)
      .set(softDelete)
      .where(
        and(
          eq(requestComments.organizationId, context.organizationId),
          eq(requestComments.requestId, requestId),
          eq(requestComments.parentId, commentId),
          isNull(requestComments.deletedAt),
        ),
      );
    await tenantDrizzle(runner)
      .update(requestComments)
      .set(softDelete)
      .where(
        and(
          eq(requestComments.organizationId, context.organizationId),
          eq(requestComments.requestId, requestId),
          eq(requestComments.id, commentId),
          isNull(requestComments.deletedAt),
        ),
      );
  }
}

/** A tiny helper the service uses to spell "top-level comment" in one place. */
export function isTopLevel(row: RequestCommentRow): boolean {
  return row.parentId === null;
}
