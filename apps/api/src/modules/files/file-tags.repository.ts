import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileTags } from '../../common/database/schema.js';
import type { FileTagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * File tags — x270's storage half (Files module).
 *
 * One table serves two row kinds (see `0140_file_tags.sql`): a **definition** row carries `name`
 * with `file_id`/`tag_id` NULL; an **assignment** row carries `file_id` + `tag_id` with `name` NULL.
 * Every read and write is bound to `(organization_id, …)`, so a caller in the wrong tenant sees
 * nothing rather than a leak, and the repository holds no policy — the service decides who may read
 * or write, and the composite foreign keys of migration 0140 make a cross-tenant file or tag id a
 * non-existent pair.
 */

/** The largest tag page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_FILE_TAGS_PAGE = 500;

export class FileTagsRepository {
  /** The tenant's tag definitions, name-ascending, bounded to one page. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_FILE_TAGS_PAGE,
  ): Promise<readonly FileTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(and(eq(fileTags.organizationId, context.organizationId), isNull(fileTags.fileId)))
      .orderBy(asc(fileTags.name), asc(fileTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_TAGS_PAGE));
  }

  /** One tag definition, scoped to the tenant; `null` if absent (or if the id names an assignment). */
  async findDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    tagId: string,
  ): Promise<FileTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(
        and(
          eq(fileTags.organizationId, context.organizationId),
          eq(fileTags.id, tagId),
          isNull(fileTags.fileId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A definition with this name in the tenant; `null` if the name is free. */
  async findDefinitionByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<FileTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(
        and(
          eq(fileTags.organizationId, context.organizationId),
          eq(fileTags.name, name),
          isNull(fileTags.fileId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a tag. Definition rows carry `name` and NULL `file_id`/`tag_id`. */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<FileTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileTags)
      .values({
        id,
        organizationId: context.organizationId,
        fileId: null,
        tagId: null,
        name,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findDefinition(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('file tag definition vanished immediately after insert');
    }
    return created;
  }

  /** The assignment rows for one file of this tenant. */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    limit: number = MAX_FILE_TAGS_PAGE,
  ): Promise<readonly FileTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(and(eq(fileTags.organizationId, context.organizationId), eq(fileTags.fileId, fileId)))
      .orderBy(asc(fileTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_TAGS_PAGE));
  }

  /** The assignment rows that name one tag of this tenant — the upload-centre filter's read. */
  async listAssignmentsForTag(
    runner: TenantQueryRunner,
    context: TenantContext,
    tagId: string,
    limit: number = MAX_FILE_TAGS_PAGE,
  ): Promise<readonly FileTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(and(eq(fileTags.organizationId, context.organizationId), eq(fileTags.tagId, tagId)))
      .orderBy(asc(fileTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_TAGS_PAGE));
  }

  /** One assignment of a tag to a file, scoped to the tenant; `null` if not tagged. */
  async findAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    tagId: string,
  ): Promise<FileTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileTags)
      .where(
        and(
          eq(fileTags.organizationId, context.organizationId),
          eq(fileTags.fileId, fileId),
          eq(fileTags.tagId, tagId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Tag a file with a tag. Assignment rows carry `file_id` + `tag_id`. */
  async createAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    tagId: string,
  ): Promise<FileTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileTags)
      .values({
        id,
        organizationId: context.organizationId,
        fileId,
        tagId,
        name: null,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findAssignment(runner, context, fileId, tagId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('file tag assignment vanished immediately after insert');
    }
    return created;
  }

  /** Untag: remove a tag assignment from a file. `true` if a row was removed. */
  async deleteAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    tagId: string,
  ): Promise<boolean> {
    const existing = await this.findAssignment(runner, context, fileId, tagId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(fileTags)
      .where(
        and(
          eq(fileTags.organizationId, context.organizationId),
          eq(fileTags.fileId, fileId),
          eq(fileTags.tagId, tagId),
        ),
      );
    return true;
  }
}
