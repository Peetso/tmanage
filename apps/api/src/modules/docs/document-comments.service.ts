import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentCommentsRepository } from './document-comments.repository.js';
import type { ListDocumentCommentsOptions } from './document-comments.repository.js';
import type { DocumentCommentRow, DocumentRow } from '../../common/database/schema.js';

/**
 * The application service for document comments — Docs "collaboration later" (x132). It follows the
 * `DocumentsService` shape: the route guard asks the coarse `doc.read`/`doc.write` question, and this
 * service adds the **relation** check with the document's project in hand.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks `doc.read` / `doc.write`: does this role's ceiling include the
 * capability at all. This service adds the relation check — an internal member without
 * organization-wide scope reads and writes only the projects they belong to. That relation check is
 * expressed with the sibling `work.read` / `work.create` capabilities, exactly as `DocumentsService`
 * does: `doc.read` was declared as a ceiling-mirror of `work.read` and `doc.write` of `work.create`
 * (see `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for
 * every role, and `work.*` is what `authorize()` already relation-gates. Relation-gating `doc.*`
 * directly in `authorize.ts` would be an edit to the security core this slice does not need.
 *
 * A comment carries no `project_id`: the relation it is read and written by is the document's,
 * resolved here so the two can never disagree — the posture `MeetingNotesService` takes with a
 * meeting's project.
 */

/** What a caller is allowed to see of one document comment. `organizationId` is deliberately absent. */
export interface DocumentCommentView {
  readonly id: string;
  readonly documentId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `document_comments` in a future migration is invisible to every
 * caller until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: DocumentCommentRow): DocumentCommentView {
  return {
    id: row.id,
    documentId: row.documentId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `document_comments.body` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte max. */
const MAX_BODY_LENGTH = 60_000;

export class DocumentCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly comments: DocumentCommentsRepository = new DocumentCommentsRepository(),
  ) {}

  /**
   * Resolve a document the principal may act on, tenant-scoped **before** the relation check.
   *
   * This is the Known-trap order (FAST-PROTOCOL 19:55, `DocumentsService.requireActionable`): the
   * document is read scoped to the tenant first, so a missing id — or one that belongs to another
   * tenant — returns null here and becomes a **404**, never a foreign-key 500 reached by an org-wide
   * caller who would pass the relation check regardless. A document the caller may not act on is also
   * 404, never 403: 403 would confirm the document exists, which is exactly what a non-member must
   * not be able to probe.
   */
  private async requireActionable(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documents.findById(runner, context, documentId),
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

  /**
   * List a document's comments, oldest first, for a caller who may read the document.
   *
   * `doc.read`, relation-gated as `work.read`. The document is resolved tenant-scoped first, so an
   * unknown, cross-tenant, or non-member document id is a 404 before any comment is read.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    options: ListDocumentCommentsOptions = {},
  ): Promise<readonly DocumentCommentView[]> {
    await this.requireActionable(context, principal, documentId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.comments.list(runner, context, documentId, options),
    );
    return rows.map(toView);
  }

  /**
   * Add a comment to a document. `doc.write`, relation-gated as `work.create`.
   *
   * The document is resolved tenant-scoped and authorized **before** the write, so an unknown,
   * cross-tenant, or non-member document id is a 404 and **nothing is written** (the Known trap).
   * The author is the acting membership (`context.membershipId`), never a value from the body.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    body: string,
  ): Promise<DocumentCommentView> {
    await this.requireActionable(context, principal, documentId, 'work.create');
    const row = await this.database.transaction(context, (tx) =>
      this.comments.append(tx, context, {
        documentId,
        body,
        authorMembershipId: context.membershipId,
      }),
    );
    return toView(row);
  }

  /** The maximum comment body length the controller validates against before calling {@link add}. */
  static get maxBodyLength(): number {
    return MAX_BODY_LENGTH;
  }
}
