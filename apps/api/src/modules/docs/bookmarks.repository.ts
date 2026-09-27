import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docBookmarks, documents } from '../../common/database/schema.js';
import type { DocBookmarkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC bookmarks / favorites (x242) — a membership's private favorites over `documents` rows. It owns
 * the bookmark insert, the unbookmark delete, and the newest-first list of a membership's bookmarks
 * joined to their live documents. It follows the `home_pinned_items` repository (x144) pattern and
 * honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddBookmarkInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the check-then-insert on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddBookmarkInput {
  readonly docId: string;
  /** The bookmarking membership — the service passes `context.membershipId`. */
  readonly membershipId: string;
}

/** One bookmark joined to the document it points at, for the caller's list. */
export interface BookmarkedDocumentRow {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: Date;
}

/** A membership's favorites list carries the full document title, so a long list must not be unbounded. */
const MAX_BOOKMARKS_LISTED = 200;

export class DocBookmarksRepository {
  /** Fetch one membership's bookmark of one document, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
    membershipId: string,
  ): Promise<DocBookmarkRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docBookmarks)
      .where(
        and(
          eq(docBookmarks.organizationId, context.organizationId),
          eq(docBookmarks.docId, docId),
          eq(docBookmarks.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Bookmark a document for a membership, idempotently. If the bookmark already exists it is returned
   * unchanged (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant withholds
   * UPDATE); otherwise a new row is inserted. The `(organization_id, doc_id, membership_id)` unique key
   * is the guard: a racing insert that collides is caught and the existing row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddBookmarkInput,
  ): Promise<DocBookmarkRow> {
    const existing = await this.find(runner, context, input.docId, input.membershipId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(docBookmarks).values({
        id,
        organizationId: context.organizationId,
        docId: input.docId,
        membershipId: input.membershipId,
        createdAt: new Date(),
      });
    } catch (error) {
      // A concurrent PUT won the unique key first; the bookmark now exists, so re-read it and treat
      // this call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, input.docId, input.membershipId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, input.docId, input.membershipId);
    return inserted as DocBookmarkRow;
  }

  /** Remove a membership's bookmark of a document, scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
    membershipId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(docBookmarks)
      .where(
        and(
          eq(docBookmarks.organizationId, context.organizationId),
          eq(docBookmarks.docId, docId),
          eq(docBookmarks.membershipId, membershipId),
        ),
      );
  }

  /**
   * List one membership's bookmarks, newest first, joined to the live document. The inner join drops
   * a bookmark whose document no longer exists; the service further filters to documents the caller
   * can still read. Bounded.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly BookmarkedDocumentRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: docBookmarks.id,
        docId: docBookmarks.docId,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: docBookmarks.createdAt,
      })
      .from(docBookmarks)
      .innerJoin(
        documents,
        and(
          eq(documents.organizationId, docBookmarks.organizationId),
          eq(documents.id, docBookmarks.docId),
        ),
      )
      .where(
        and(
          eq(docBookmarks.organizationId, context.organizationId),
          eq(docBookmarks.membershipId, membershipId),
        ),
      )
      .orderBy(desc(docBookmarks.createdAt), desc(docBookmarks.id))
      .limit(MAX_BOOKMARKS_LISTED);
  }
}
