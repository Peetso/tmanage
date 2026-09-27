import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { decisionComments } from '../../common/database/schema.js';
import type { DecisionCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Decision comments — x317's storage half (Requests, decisions & approvals: decision discussion).
 *
 * Follows `DocumentCommentsRepository`/`WorkCommentsRepository`: `TenantContext` is the scoping
 * parameter, no `organizationId` on any input type (it comes from the context), and every read,
 * insert and delete is bound to `(organization_id, …)` so a caller in the wrong tenant sees and
 * touches nothing. The repository holds no policy — the service decides who may read, write or
 * delete, and the composite foreign key of migration 0185 is what makes a cross-tenant
 * `decision_id` a non-existent pair.
 */

/** The largest comment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_COMMENT_PAGE = 500;

export interface CreateCommentInput {
  readonly decisionId: string;
  readonly authorMembershipId: string;
  readonly body: string;
}

export class DecisionCommentsRepository {
  /** One comment, scoped to the tenant and its parent decision; `null` if absent. */
  async findComment(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    commentId: string,
  ): Promise<DecisionCommentRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(decisionComments)
      .where(
        and(
          eq(decisionComments.organizationId, context.organizationId),
          eq(decisionComments.decisionId, decisionId),
          eq(decisionComments.id, commentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The decision's comments, created-at ascending then id, bounded to one page. */
  async listForDecision(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    limit: number = MAX_COMMENT_PAGE,
  ): Promise<readonly DecisionCommentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(decisionComments)
      .where(
        and(
          eq(decisionComments.organizationId, context.organizationId),
          eq(decisionComments.decisionId, decisionId),
        ),
      )
      .orderBy(asc(decisionComments.createdAt), asc(decisionComments.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_COMMENT_PAGE));
  }

  /** Append a comment. The server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateCommentInput,
  ): Promise<DecisionCommentRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(decisionComments)
      .values({
        id,
        organizationId: context.organizationId,
        decisionId: input.decisionId,
        authorMembershipId: input.authorMembershipId,
        body: input.body,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findComment(runner, context, input.decisionId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('decision comment vanished immediately after insert');
    }
    return created;
  }

  /**
   * Delete one comment, scoped to the tenant, its parent decision and its author. A comment that is
   * not this author's matches no row and is deleted no-op, so the service's author check is the one
   * place the "own comment only" rule is written, with this predicate as the tenant-and-author
   * backstop the way every write here is tenant-scoped.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    commentId: string,
    authorMembershipId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(decisionComments)
      .where(
        and(
          eq(decisionComments.organizationId, context.organizationId),
          eq(decisionComments.decisionId, decisionId),
          eq(decisionComments.id, commentId),
          eq(decisionComments.authorMembershipId, authorMembershipId),
        ),
      );
  }
}
