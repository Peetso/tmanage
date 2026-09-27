import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocBookmarksRepository } from './bookmarks.repository.js';

/**
 * DOC bookmarks / favorites (x242) — a member bookmarks a document they can read, unbookmarks it, and
 * lists their own favorites. A per-membership surface kept in its own table `doc_bookmarks` and its own
 * module, so it touches no file another docs slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `doc.read` question a guard can answer with no object loaded — every
 * bookmark route is `doc.read`, because a member bookmarks a document they may *read*. This service
 * adds the object-level decision with the document's row in hand: it resolves the document
 * **tenant-scoped before** it authorizes (the Known-trap order — `DocumentsService.requireActionable`),
 * so a missing id, or one that belongs to another tenant, is a **404**, never a foreign-key 500 reached
 * by an org-wide caller who would pass the relation check regardless. A document the caller may not read
 * is also 404, never 403 — a 403 would confirm the document exists, which a non-member must not probe.
 *
 * The relation check is expressed with `work.read` rather than `doc.read`: `doc.read` was declared as a
 * ceiling-mirror of `work.read` (see `packages/domain`'s `capabilities.ts`), so the two are equal by
 * construction for every role, and `work.read` is what `authorize()` already relation-gates. This is the
 * exact reasoning `DocumentsService` records.
 *
 * A bookmark is always the caller's own: every write and the list are scoped to `context.membershipId`,
 * so a member can never create, remove, or read another member's bookmarks even inside the same tenant.
 */

/**
 * What a caller sees of one bookmarked document — paired Exact with the web's `DocBookmarkSummary`.
 * `organizationId`/`membershipId` are deliberately absent — the wire projection never echoes the tenant
 * id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface DocBookmarkView {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class DocBookmarksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly bookmarks: DocBookmarksRepository = new DocBookmarksRepository(),
  ) {}

  /**
   * Resolve a document the principal may read, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not read, is 404 — never 403, never 500. Returns the
   * row so a caller can build the view without a second read.
   */
  private async requireReadable(
    context: TenantContext,
    principal: Principal,
    docId: string,
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documentsRepo.findById(runner, context, docId),
    );

    const permitted =
      row !== null &&
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: row.organizationId,
          projectId: row.projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;

    if (!row || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }
    return row;
  }

  /** Whether the caller has bookmarked a document they can read. */
  async status(
    context: TenantContext,
    principal: Principal,
    docId: string,
  ): Promise<{ readonly bookmarked: boolean }> {
    await this.requireReadable(context, principal, docId);
    const existing = await this.database.read(context, (runner) =>
      this.bookmarks.find(runner, context, docId, context.membershipId),
    );
    return { bookmarked: existing !== null };
  }

  /**
   * Bookmark a document for the caller, idempotently. A repeated PUT returns the same view, never a
   * second row. The document is resolved readable first (Known-trap 404 order).
   */
  async add(context: TenantContext, principal: Principal, docId: string): Promise<DocBookmarkView> {
    const document = await this.requireReadable(context, principal, docId);
    const row = await this.database.transaction(context, (tx) =>
      this.bookmarks.add(tx, context, { docId, membershipId: context.membershipId }),
    );
    return {
      id: row.id,
      docId: row.docId,
      title: document.title,
      projectId: document.projectId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Remove the caller's bookmark of a document, idempotently (no bookmark → still success). */
  async remove(context: TenantContext, principal: Principal, docId: string): Promise<void> {
    await this.requireReadable(context, principal, docId);
    await this.database.transaction(context, (tx) =>
      this.bookmarks.remove(tx, context, docId, context.membershipId),
    );
  }

  /**
   * List the caller's bookmarks, newest first, projected to the documents they can **still** read. A
   * bookmarked document the caller has since lost read access to is dropped, so the list never leaks a
   * title the caller may no longer see.
   */
  async list(context: TenantContext, principal: Principal): Promise<readonly DocBookmarkView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.bookmarks.listForMember(runner, context, context.membershipId),
    );
    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: context.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map((row) => ({
        id: row.id,
        docId: row.docId,
        title: row.title,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
