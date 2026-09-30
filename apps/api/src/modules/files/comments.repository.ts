import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileComments } from '../../common/database/schema.js';
import type { FileCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * File comments — x333's storage half (Files module).
 *
 * Every read and write is bound to `(organization_id, …)`, so a caller in the wrong tenant sees
 * nothing rather than a leak, and the composite foreign key of migration 0199 makes a cross-tenant
 * `file_asset_id` a non-existent pair. The repository holds no policy — the service decides who may
 * read, write, or delete; here there is only the tenant predicate on every statement, following the
 * `document_comments` repository shape (x132).
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** No `organizationId` — it comes from the context, so there is no field for a body to populate. */
export interface AppendFileCommentInput {
  readonly fileAssetId: string;
  readonly body: string;
  /** The membership the comment is written under — the service passes `context.membershipId`. */
  readonly createdBy: string;
}

/** The largest comment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_FILE_COMMENTS_PAGE = 200;

export class FileCommentsRepository {
  /**
   * List one file's comments, within the acting tenant, oldest first.
   *
   * Both `organization_id` and `file_asset_id` predicates are present. The order is `created_at`
   * then `id` — the schema's `ix_file_comments_file` index — so the walk is chronological (a
   * conversation reads oldest-first). Bounded to one page.
   */
  async listForFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    limit: number = MAX_FILE_COMMENTS_PAGE,
  ): Promise<readonly FileCommentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileComments)
      .where(
        and(
          eq(fileComments.organizationId, context.organizationId),
          eq(fileComments.fileAssetId, fileAssetId),
        ),
      )
      .orderBy(asc(fileComments.createdAt), asc(fileComments.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_COMMENTS_PAGE));
  }

  /** One comment, scoped to the tenant and its file; `null` if absent (or on another file). */
  async findOnFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    commentId: string,
  ): Promise<FileCommentRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileComments)
      .where(
        and(
          eq(fileComments.organizationId, context.organizationId),
          eq(fileComments.fileAssetId, fileAssetId),
          eq(fileComments.id, commentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Append a comment. The id is generated here (UUIDv7); `organization_id` comes from the context. */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendFileCommentInput,
  ): Promise<FileCommentRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileComments)
      .values({
        id,
        organizationId: context.organizationId,
        fileAssetId: input.fileAssetId,
        body: input.body,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findOnFile(runner, context, input.fileAssetId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('file comment vanished immediately after insert');
    }
    return created;
  }

  /** Remove one comment, scoped to the tenant and its file. `true` if a row was removed. */
  async deleteOnFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    commentId: string,
  ): Promise<boolean> {
    const existing = await this.findOnFile(runner, context, fileAssetId, commentId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(fileComments)
      .where(
        and(
          eq(fileComments.organizationId, context.organizationId),
          eq(fileComments.fileAssetId, fileAssetId),
          eq(fileComments.id, commentId),
        ),
      );
    return true;
  }
}
