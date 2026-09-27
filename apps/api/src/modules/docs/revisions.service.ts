import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocRevisionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocRevisionsRepository } from './revisions.repository.js';

/**
 * DOC revision history (x241) — snapshot a document's body on save, list the trail newest-first, and
 * restore a prior snapshot. A parallel of `document_versions` (x112) that this slice keeps in its own
 * table `doc_revisions` and its own module, so it touches no file another docs slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `doc.read`/`doc.write` question a guard can honestly answer with no
 * object loaded. This service adds the object-level decision with the document's row in hand: it
 * resolves the document **tenant-scoped before** it authorizes (the Known-trap order —
 * `DocumentsService.requireActionable`), so a missing id, or one that belongs to another tenant, is a
 * **404**, never a foreign-key 500 reached by an org-wide caller who would pass the relation check
 * regardless. A document the caller may not act on is also 404, never 403 — 403 would confirm the
 * document exists, which is exactly what a non-member must not be able to probe.
 *
 * The relation check is expressed with `work.read`/`work.create` rather than `doc.read`/`doc.write`:
 * `doc.*` was declared as a ceiling-mirror of `work.*` (see `packages/domain`'s `capabilities.ts`),
 * so the two are equal by construction for every role, and `work.*` is what `authorize()` already
 * relation-gates. This is the exact reasoning `DocumentsService` records.
 */

/**
 * What a caller is allowed to see of one document revision. `organizationId` is deliberately absent —
 * the wire projection never echoes the tenant id (`25-AUTH` §7).
 */
export interface DocRevisionView {
  readonly id: string;
  readonly docId: string;
  readonly revNo: number;
  readonly bodySnapshot: string;
  readonly savedBy: string;
  readonly savedAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: DocRevisionRow): DocRevisionView {
  return {
    id: row.id,
    docId: row.docId,
    revNo: row.revNo,
    bodySnapshot: row.bodySnapshot,
    savedBy: row.savedBy,
    savedAt: row.savedAt.toISOString(),
  };
}

export class RevisionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly revisions: DocRevisionsRepository = new DocRevisionsRepository(),
  ) {}

  /**
   * Resolve a document the principal may act on, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not act on, is 404 — never 403, never 500.
   */
  private async requireActionable(
    context: TenantContext,
    principal: Principal,
    docId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<void> {
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
  }

  /** List a document's revisions, newest first, for a caller who may read the document. */
  async list(
    context: TenantContext,
    principal: Principal,
    docId: string,
  ): Promise<readonly DocRevisionView[]> {
    await this.requireActionable(context, principal, docId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.revisions.list(runner, context, docId),
    );
    return rows.map(toView);
  }

  /**
   * Capture a revision: append an immutable snapshot of the body and bump the document's current
   * body, in one transaction. `doc.write`, relation-gated as `work.create`.
   */
  async capture(
    context: TenantContext,
    principal: Principal,
    docId: string,
    bodySnapshot: string,
  ): Promise<DocRevisionView> {
    await this.requireActionable(context, principal, docId, 'work.create');
    const row = await this.database.transaction(context, (tx) =>
      this.revisions.append(tx, context, { docId, bodySnapshot, savedBy: context.userId }),
    );
    return toView(row);
  }

  /**
   * Restore a revision: write a NEW revision whose body equals a prior snapshot (forward-append,
   * history is never mutated) and bump the document's current body to it. `doc.write`. A revision id
   * that does not exist for this document is 404, and nothing is written.
   */
  async restore(
    context: TenantContext,
    principal: Principal,
    docId: string,
    revisionId: string,
  ): Promise<DocRevisionView> {
    await this.requireActionable(context, principal, docId, 'work.create');

    const source = await this.database.read(context, (runner) =>
      this.revisions.findById(runner, context, docId, revisionId),
    );
    if (!source) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'revision_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.revisions.append(tx, context, {
        docId,
        bodySnapshot: source.bodySnapshot,
        savedBy: context.userId,
      }),
    );
    return toView(row);
  }
}
