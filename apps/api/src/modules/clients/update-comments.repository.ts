import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectUpdateComments } from '../../common/database/schema.js';
import type { ProjectUpdateCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SEC / Portal update comments (x203) — the storage half. Append-only, tenant- and parent-scoped,
 * following `WorkCommentsRepository` (0053): `TenantContext` is the scoping parameter on every
 * method, there is no `organizationId` on any input (it comes from the context), and every read and
 * write is bound to `(organization_id, …)` so a caller in the wrong tenant sees nothing. The
 * repository holds no policy — the service decides who may read or write — and offers no update or
 * delete, mirroring the withheld privilege in `users.sql` and the 0084 append-only trigger.
 */

/** The largest comment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_UPDATE_COMMENT_PAGE = 500;

/** The insert shape. Note the absence of `organizationId` — it comes from the context. */
export interface CreateUpdateCommentInput {
  readonly updateId: string;
  readonly body: string;
  readonly createdByUserId: string;
}

export class ProjectUpdateCommentsRepository {
  /** One update's comments, created-at (then id) ascending, bounded to one page. */
  async listForUpdate(
    runner: TenantQueryRunner,
    context: TenantContext,
    updateId: string,
  ): Promise<readonly ProjectUpdateCommentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(projectUpdateComments)
      .where(
        and(
          eq(projectUpdateComments.organizationId, context.organizationId),
          eq(projectUpdateComments.updateId, updateId),
          // PA-03 (0245): a soft-deleted comment leaves the list.
          isNull(projectUpdateComments.deletedAt),
        ),
      )
      .orderBy(asc(projectUpdateComments.createdAt), asc(projectUpdateComments.id))
      .limit(MAX_UPDATE_COMMENT_PAGE);
  }

  /** One comment, scoped to the tenant and its parent update; `null` if absent. */
  async findComment(
    runner: TenantQueryRunner,
    context: TenantContext,
    updateId: string,
    commentId: string,
  ): Promise<ProjectUpdateCommentRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectUpdateComments)
      .where(
        and(
          eq(projectUpdateComments.organizationId, context.organizationId),
          eq(projectUpdateComments.updateId, updateId),
          eq(projectUpdateComments.id, commentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Append a comment. `organization_id` comes from the context, never `input`. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateUpdateCommentInput,
  ): Promise<ProjectUpdateCommentRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(projectUpdateComments)
      .values({
        id,
        organizationId: context.organizationId,
        updateId: input.updateId,
        body: input.body,
        createdByUserId: input.createdByUserId,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findComment(runner, context, input.updateId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('project update comment vanished immediately after insert');
    }
    return created;
  }
}
