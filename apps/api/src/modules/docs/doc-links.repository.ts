import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docLinks, documents } from '../../common/database/schema.js';
import type { DocLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC links + backlinks (x296) — an author's wiki-style relations over `documents` rows. It owns the
 * link insert, the unlink delete, the newest-first list of a document's outgoing links joined to their
 * live target documents, and the reverse (incoming) list for backlinks. It follows the
 * `doc_bookmarks` repository (x242) / `work_item_links` (x204) pattern and honours `25-AUTH` §6
 * structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddLinkInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes resolve-then-insert on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddLinkInput {
  readonly sourceDocId: string;
  readonly targetDocId: string;
  /** The authoring user — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

/** One link joined to the document on its "other" end, for a caller's outgoing or backlinks list. */
export interface LinkedDocumentRow {
  readonly id: string;
  /** The document on the far end of the edge — the target for outgoing, the source for backlinks. */
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: Date;
}

/** A document's link list carries the full title, so it must not be unbounded. */
const MAX_LINKS_LISTED = 200;

export class DocLinksRepository {
  /** Fetch one directed link (source → target), scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    sourceDocId: string,
    targetDocId: string,
  ): Promise<DocLinkRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docLinks)
      .where(
        and(
          eq(docLinks.organizationId, context.organizationId),
          eq(docLinks.sourceDocId, sourceDocId),
          eq(docLinks.targetDocId, targetDocId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Link one document to another, idempotently. If the directed edge already exists it is returned
   * unchanged (a repeated create is a no-op, never a second row and never an UPDATE — the grant
   * withholds UPDATE); otherwise a new row is inserted. The `(organization_id, source_doc_id,
   * target_doc_id)` unique key is the guard: a racing insert that collides is caught and the existing
   * row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddLinkInput,
  ): Promise<DocLinkRow> {
    const existing = await this.find(runner, context, input.sourceDocId, input.targetDocId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(docLinks).values({
        id,
        organizationId: context.organizationId,
        sourceDocId: input.sourceDocId,
        targetDocId: input.targetDocId,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
      });
    } catch (error) {
      // A concurrent create won the unique key first; the edge now exists, so re-read it and treat
      // this call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, input.sourceDocId, input.targetDocId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, input.sourceDocId, input.targetDocId);
    return inserted as DocLinkRow;
  }

  /** Remove a directed link (source → target), scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    sourceDocId: string,
    targetDocId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(docLinks)
      .where(
        and(
          eq(docLinks.organizationId, context.organizationId),
          eq(docLinks.sourceDocId, sourceDocId),
          eq(docLinks.targetDocId, targetDocId),
        ),
      );
  }

  /**
   * List a document's outgoing links, newest first, joined to the live target document. The inner join
   * drops a link whose target no longer exists; the service further filters to documents the caller
   * can still read. Bounded.
   */
  async listOutgoing(
    runner: TenantQueryRunner,
    context: TenantContext,
    sourceDocId: string,
  ): Promise<readonly LinkedDocumentRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: docLinks.id,
        docId: docLinks.targetDocId,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: docLinks.createdAt,
      })
      .from(docLinks)
      .innerJoin(
        documents,
        and(
          eq(documents.organizationId, docLinks.organizationId),
          eq(documents.id, docLinks.targetDocId),
        ),
      )
      .where(
        and(
          eq(docLinks.organizationId, context.organizationId),
          eq(docLinks.sourceDocId, sourceDocId),
        ),
      )
      .orderBy(desc(docLinks.createdAt), desc(docLinks.id))
      .limit(MAX_LINKS_LISTED);
  }

  /**
   * List the links pointing AT a document (backlinks / "linked from"), newest first, joined to the live
   * source document. The inner join drops a link whose source no longer exists; the service further
   * filters to documents the caller can still read, so a backlink never leaks a document the caller
   * may not see. Bounded.
   */
  async listBacklinks(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetDocId: string,
  ): Promise<readonly LinkedDocumentRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: docLinks.id,
        docId: docLinks.sourceDocId,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: docLinks.createdAt,
      })
      .from(docLinks)
      .innerJoin(
        documents,
        and(
          eq(documents.organizationId, docLinks.organizationId),
          eq(documents.id, docLinks.sourceDocId),
        ),
      )
      .where(
        and(
          eq(docLinks.organizationId, context.organizationId),
          eq(docLinks.targetDocId, targetDocId),
        ),
      )
      .orderBy(desc(docLinks.createdAt), desc(docLinks.id))
      .limit(MAX_LINKS_LISTED);
  }
}
