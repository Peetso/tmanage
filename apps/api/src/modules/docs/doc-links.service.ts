import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocLinksRepository } from './doc-links.repository.js';

/**
 * DOC links + backlinks (x296) — an author links one document to another (wiki-style relation), and a
 * reader sees a read-only "linked from" (backlinks) list. A tenant-scoped surface kept in its own table
 * `doc_links` and its own controller pair, so it touches no file another docs slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse question a guard can answer with no object loaded — `doc.write` to
 * add or remove a link, `doc.read` to list. This service adds the object-level decision with the
 * documents' rows in hand: it resolves each end **tenant-scoped before** it authorizes (the Known-trap
 * order — `DocumentsService.requireActionable`), so a missing id, or one that belongs to another
 * tenant, is a **404**, never a foreign-key 500 reached by an org-wide caller who would pass the
 * relation check regardless. A document the caller may not act on / read is also 404, never 403 — a
 * 403 would confirm the document exists, which a non-member must not probe.
 *
 * The relation check is expressed with `work.create` (write) / `work.read` (read) rather than
 * `doc.write` / `doc.read`: `doc.write` was declared a ceiling-mirror of `work.create` and `doc.read`
 * of `work.read` (see `packages/domain`'s `capabilities.ts`), so the two are equal by construction for
 * every role, and `work.*` is what `authorize()` already relation-gates. This is the exact reasoning
 * `DocumentsService` records.
 *
 * A link written on a source document requires **write** on that source; its target need only be
 * **readable** — you may link to any document you can read, but the far end is never leaked. Both the
 * outgoing and the backlinks lists are re-projected at read time to the documents the caller can still
 * read, so neither leaks the existence or title of a document the caller may not see.
 */

/**
 * What a caller sees of one linked document — paired Exact with the web's `DocLinkSummary`. For an
 * outgoing link `docId` is the target; for a backlink it is the source. `organizationId`/the authoring
 * user are deliberately absent — the wire projection never echoes the tenant id (`25-AUTH` §7) nor the
 * author.
 */
export interface DocLinkView {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class DocLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly links: DocLinksRepository = new DocLinksRepository(),
  ) {}

  /**
   * Resolve a document the principal may act on with `capability`, tenant-scoped **before** the
   * relation check. A missing/cross-tenant id, or one the caller may not reach, is 404 — never 403,
   * never 500. Returns the row so a caller can build the view without a second read.
   */
  private async requireActionable(
    context: TenantContext,
    principal: Principal,
    docId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documentsRepo.findById(runner, context, docId),
    );

    const permitted =
      row !== null &&
      authorize({
        principal,
        capability,
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

  private canRead(context: TenantContext, principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Link a source document to a target, idempotently (`doc.write`, relation-gated `work.create` on the
   * source). The source is resolved writable and the target readable first — both tenant-scoped, so a
   * cross-tenant end is a 404 with nothing written (Known-trap order). A self-link (source === target)
   * is a 400 with no insert. A repeated create returns the same view, never a second row.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    sourceDocId: string,
    targetDocId: string,
  ): Promise<DocLinkView> {
    if (sourceDocId === targetDocId) {
      throw new ApiError(400, 'validation_failed', 'A document cannot link to itself', [
        { field: 'targetDocId', message: 'must differ from the source document' },
      ]);
    }
    // Source first: write authority on the document the link is authored on.
    await this.requireActionable(context, principal, sourceDocId, 'work.create');
    // Target next: it need only be readable, and is resolved tenant-scoped so a cross-tenant target is
    // a 404 with nothing written — no existence leak.
    const target = await this.requireActionable(context, principal, targetDocId, 'work.read');

    const row = await this.database.transaction(context, (tx) =>
      this.links.add(tx, context, {
        sourceDocId,
        targetDocId,
        createdByUserId: context.userId,
      }),
    );
    return {
      id: row.id,
      docId: row.targetDocId,
      title: target.title,
      projectId: target.projectId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Remove a source → target link, idempotently (`doc.write`, relation-gated `work.create` on the
   * source). The source is resolved writable first (Known-trap 404 order); no link is still success.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    sourceDocId: string,
    targetDocId: string,
  ): Promise<void> {
    await this.requireActionable(context, principal, sourceDocId, 'work.create');
    await this.database.transaction(context, (tx) =>
      this.links.remove(tx, context, sourceDocId, targetDocId),
    );
  }

  /**
   * List a document's outgoing links (`doc.read`, relation-gated `work.read`), projected to the target
   * documents the caller can **still** read. The source is resolved readable first.
   */
  async listOutgoing(
    context: TenantContext,
    principal: Principal,
    sourceDocId: string,
  ): Promise<readonly DocLinkView[]> {
    await this.requireActionable(context, principal, sourceDocId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.links.listOutgoing(runner, context, sourceDocId),
    );
    return rows
      .filter((row) => this.canRead(context, principal, row.projectId))
      .map((row) => ({
        id: row.id,
        docId: row.docId,
        title: row.title,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
      }));
  }

  /**
   * List the documents that link TO a document (backlinks / "linked from"), `doc.read` relation-gated
   * `work.read`, projected to the source documents the caller can **still** read — readability is
   * re-checked at read time, so a backlink never leaks a document the caller may not see. The target is
   * resolved readable first.
   */
  async listBacklinks(
    context: TenantContext,
    principal: Principal,
    targetDocId: string,
  ): Promise<readonly DocLinkView[]> {
    await this.requireActionable(context, principal, targetDocId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.links.listBacklinks(runner, context, targetDocId),
    );
    return rows
      .filter((row) => this.canRead(context, principal, row.projectId))
      .map((row) => ({
        id: row.id,
        docId: row.docId,
        title: row.title,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
