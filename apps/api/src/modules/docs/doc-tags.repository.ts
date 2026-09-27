import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docTags } from '../../common/database/schema.js';
import type { DocTagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Document tags / labels — x269's storage half (Docs module).
 *
 * One table serves two row kinds (see `0139_doc_tags.sql`): a **definition** row carries `name` with
 * `document_id`/`tag_id` NULL; an **assignment** row carries `document_id` + `tag_id` with `name`
 * NULL. Every read and write is bound to `(organization_id, …)`, so a caller in the wrong tenant sees
 * nothing rather than a leak, and the repository holds no policy — the service decides who may read or
 * write, and the composite foreign keys of migration 0139 make a cross-tenant document or tag id a
 * non-existent pair. Follows the `work_item_labels` repository (x233) pattern; the runner is a
 * parameter, not a field, so the service composes check-then-insert on one connection in one
 * transaction.
 */

/** The largest tag page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_DOC_TAGS_PAGE = 500;

export class DocTagsRepository {
  /** The tenant's tag definitions, name-ascending, bounded to one page. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_DOC_TAGS_PAGE,
  ): Promise<readonly DocTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(docTags)
      .where(and(eq(docTags.organizationId, context.organizationId), isNull(docTags.documentId)))
      .orderBy(asc(docTags.name), asc(docTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_DOC_TAGS_PAGE));
  }

  /** One tag definition, scoped to the tenant; `null` if absent (or if the id names an assignment). */
  async findDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    tagId: string,
  ): Promise<DocTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(docTags)
      .where(
        and(
          eq(docTags.organizationId, context.organizationId),
          eq(docTags.id, tagId),
          isNull(docTags.documentId),
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
  ): Promise<DocTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(docTags)
      .where(
        and(
          eq(docTags.organizationId, context.organizationId),
          eq(docTags.name, name),
          isNull(docTags.documentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a tag. Definition rows carry `name` and NULL `document_id`/`tag_id`. */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<DocTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(docTags)
      .values({
        id,
        organizationId: context.organizationId,
        documentId: null,
        tagId: null,
        name,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findDefinition(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('doc tag definition vanished immediately after insert');
    }
    return created;
  }

  /** The assignment rows for one document of this tenant. */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    limit: number = MAX_DOC_TAGS_PAGE,
  ): Promise<readonly DocTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(docTags)
      .where(
        and(eq(docTags.organizationId, context.organizationId), eq(docTags.documentId, documentId)),
      )
      .orderBy(asc(docTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_DOC_TAGS_PAGE));
  }

  /** One assignment of a tag to a document, scoped to the tenant; `null` if not tagged. */
  async findAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    tagId: string,
  ): Promise<DocTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(docTags)
      .where(
        and(
          eq(docTags.organizationId, context.organizationId),
          eq(docTags.documentId, documentId),
          eq(docTags.tagId, tagId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Tag a document with a tag. Assignment rows carry `document_id` + `tag_id`. */
  async createAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    tagId: string,
  ): Promise<DocTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(docTags)
      .values({
        id,
        organizationId: context.organizationId,
        documentId,
        tagId,
        name: null,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findAssignment(runner, context, documentId, tagId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('doc tag assignment vanished immediately after insert');
    }
    return created;
  }

  /** Untag: remove a tag assignment from a document. `true` if a row was removed. */
  async deleteAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    tagId: string,
  ): Promise<boolean> {
    const existing = await this.findAssignment(runner, context, documentId, tagId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(docTags)
      .where(
        and(
          eq(docTags.organizationId, context.organizationId),
          eq(docTags.documentId, documentId),
          eq(docTags.tagId, tagId),
        ),
      );
    return true;
  }
}
