import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocReadStateRepository } from './doc-read-state.repository.js';

/**
 * DOC read state (x297) — a member marks a document they can read as read, marks it unread, and reads
 * their own read-state for a batch of documents, so a "new since you last looked" badge and a "mark all
 * read" affordance can be driven client-side. A per-membership surface kept in its own table
 * `doc_read_state` and registered through `DocsModule`.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `doc.read` question a guard can answer with no object loaded — every
 * route is `doc.read`, because a member marks read a document they may *read*. This service adds the
 * object-level decision with the document's row in hand on the per-document writes: it resolves the
 * document **tenant-scoped before** it authorizes (the Known-trap order — `DocumentsService`), so a
 * missing id, or one that belongs to another tenant, is a **404**, never a foreign-key 500. A document
 * the caller may not read is also 404, never 403 — a 403 would confirm the document exists, which a
 * non-member must not probe. The relation check is expressed with `work.read` (declared a ceiling-mirror
 * of `doc.read`, so equal by construction), which is what `authorize()` already relation-gates — the
 * exact reasoning `DocumentsService`/`DocBookmarksService` record.
 *
 * Read state is always the caller's own: every write and the batch read are scoped to
 * `context.membershipId`, so a member can never set, clear, or read another member's read state even
 * inside the same tenant.
 */

/**
 * The caller's read state for one document — paired Exact with the web's `DocReadStateSummary`.
 * `organizationId`/`membershipId` are deliberately absent: the wire projection never echoes the tenant
 * id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface DocReadStateView {
  readonly docId: string;
  /** ISO-8601 instant the caller last marked this document read. */
  readonly lastReadAt: string;
}

/** A batch read is bounded so a caller cannot request an unbounded set of ids. */
const MAX_READ_STATE_IDS = 200;

export class DocReadStateService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly readState: DocReadStateRepository = new DocReadStateRepository(),
  ) {}

  /**
   * Resolve a document the principal may read, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not read, is 404 — never 403, never 500.
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

  /**
   * Mark a document read for the caller now, idempotently. A repeated PUT refreshes `last_read_at`, never
   * a second row. The document is resolved readable first (Known-trap 404 order).
   */
  async markRead(
    context: TenantContext,
    principal: Principal,
    docId: string,
  ): Promise<DocReadStateView> {
    await this.requireReadable(context, principal, docId);
    const row = await this.database.transaction(context, (tx) =>
      this.readState.markRead(tx, context, { docId, membershipId: context.membershipId }),
    );
    return { docId: row.docId, lastReadAt: row.lastReadAt.toISOString() };
  }

  /** Mark a document unread for the caller (clear the cursor), idempotently (no row → still success). */
  async markUnread(context: TenantContext, principal: Principal, docId: string): Promise<void> {
    await this.requireReadable(context, principal, docId);
    await this.database.transaction(context, (tx) =>
      this.readState.remove(tx, context, docId, context.membershipId),
    );
  }

  /**
   * The caller's read state for a batch of documents, scoped to the acting membership. Only the caller's
   * own rows are returned; a document the caller has never marked read is simply absent from the result.
   * The per-document read gate is not applied here — read state carries no document body, only the
   * caller's own cursor timestamp for ids the caller supplied — so a stale id yields no row rather than a
   * probe. Bounded to {@link MAX_READ_STATE_IDS}.
   */
  async batch(
    context: TenantContext,
    _principal: Principal,
    docIds: readonly string[],
  ): Promise<readonly DocReadStateView[]> {
    const unique = [...new Set(docIds.filter((id) => id !== ''))].slice(0, MAX_READ_STATE_IDS);
    const rows = await this.database.read(context, (runner) =>
      this.readState.findForMemberByDocIds(runner, context, context.membershipId, unique),
    );
    return rows.map((row) => ({ docId: row.docId, lastReadAt: row.lastReadAt.toISOString() }));
  }
}
