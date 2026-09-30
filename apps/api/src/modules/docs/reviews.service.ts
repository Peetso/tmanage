import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocReviewsRepository } from './reviews.repository.js';
import type { ListDocReviewsOptions } from './reviews.repository.js';
import type { DocReviewRow, DocumentRow } from '../../common/database/schema.js';

/**
 * The application service for document reviews — Docs review workflow (x313). It follows the
 * `DocumentCommentsService` shape: the route guard asks the coarse `doc.read`/`doc.write` question,
 * and this service adds the **relation** check with the document's project in hand.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks `doc.read` / `doc.write`: does this role's ceiling include the
 * capability at all. This service adds the relation check, expressed with the sibling
 * `work.read` / `work.create` capabilities exactly as `DocumentsService`/`DocumentCommentsService`
 * do: `doc.read` was declared as a ceiling-mirror of `work.read` and `doc.write` of `work.create`
 * (`packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for every
 * role, and `work.*` is what `authorize()` already relation-gates.
 *
 * ## Not-found before forbidden — and where a 403 is honest
 *
 * A document read (`work.read`) that fails — an unknown id, another tenant's id, or a document the
 * caller is not a member of — is a **404**: a non-reader must not be able to probe existence. But a
 * caller who *may read the document* yet *may not write it* (a guest holds `doc.read`/`work.read` and
 * not `doc.write`/`work.create`) is told **403**: they can already see the document, so naming the
 * missing write permission leaks nothing. This is the split the refusal test proves.
 */

/** What a caller is allowed to see of one review. `organizationId` is deliberately absent. */
export interface DocReviewView {
  readonly id: string;
  readonly documentId: string;
  readonly requestedBy: string;
  readonly reviewerUserId: string;
  readonly state: 'pending' | 'approved' | 'changes_requested';
  readonly note: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `doc_reviews` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: DocReviewRow): DocReviewView {
  return {
    id: row.id,
    documentId: row.documentId,
    requestedBy: row.requestedBy,
    reviewerUserId: row.reviewerUserId,
    state: row.state,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
  };
}

/** `doc_reviews.note` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte max. */
const MAX_NOTE_LENGTH = 60_000;

export class DocReviewsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly reviews: DocReviewsRepository = new DocReviewsRepository(),
  ) {}

  /**
   * Resolve a document the principal may read, tenant-scoped. A missing/cross-tenant/non-member id
   * is a 404 — never a 403 that would confirm existence to someone who cannot read the document.
   */
  private async requireReadableDocument(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documents.findById(runner, context, documentId),
    );
    const readable =
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
    if (!row || !readable) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }
    return row;
  }

  /**
   * A write on a document the caller may read: it must also pass `work.create`, or it is a 403.
   *
   * The document is resolved readable first (404 for a non-reader), so this 403 only ever reaches a
   * caller who can already see the document — the honest split described on the class.
   */
  private async requireWritableDocument(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.requireReadableDocument(context, principal, documentId);
    const writable = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!writable) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'doc_write_denied');
    }
    return row;
  }

  /**
   * List a document's reviews, oldest first, for a caller who may read the document (`doc.read`).
   * The document is resolved tenant-scoped first, so an unknown/cross-tenant id is a 404.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    options: ListDocReviewsOptions = {},
  ): Promise<readonly DocReviewView[]> {
    await this.requireReadableDocument(context, principal, documentId);
    const rows = await this.database.read(context, (runner) =>
      this.reviews.list(runner, context, documentId, options),
    );
    return rows.map(toView);
  }

  /**
   * Request a review of a document from a reviewer (`doc.write`).
   *
   * The document is resolved and authorized **before** the write, so an unknown/cross-tenant id is a
   * 404 and nothing is written; a reader who may not write is a 403. The reviewer is resolved
   * tenant-scoped — an unknown or cross-tenant user id is a 400. The requester is the acting
   * membership (`context.membershipId`), never a value from the body.
   */
  async request(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    input: { readonly reviewerUserId: string; readonly note: string | null },
  ): Promise<DocReviewView> {
    await this.requireWritableDocument(context, principal, documentId);

    const row = await this.database.transaction(context, async (tx) => {
      const memberReviewer = await this.reviews.reviewerIsMember(tx, context, input.reviewerUserId);
      if (!memberReviewer) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'reviewerUserId', message: 'must be a member of this organization' },
        ]);
      }
      return this.reviews.create(tx, context, {
        documentId,
        requestedBy: context.membershipId,
        reviewerUserId: input.reviewerUserId,
        note: input.note,
      });
    });
    return toView(row);
  }

  /**
   * Decide a review — approve or request changes (`doc.write`).
   *
   * The document is resolved and authorized before any write (404 for an unknown/cross-tenant
   * document even for an org-wide role; 403 for a reader who may not write). The review must belong
   * to that document and be still pending: a review that does not exist under the document is a 404,
   * and one already decided is a **409** (the decision is immutable). A `changes_requested` decision
   * requires a non-empty note (the controller validates length; empty is a 400 there).
   */
  async decide(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    reviewId: string,
    input: { readonly state: 'approved' | 'changes_requested'; readonly note: string | null },
  ): Promise<DocReviewView> {
    await this.requireWritableDocument(context, principal, documentId);

    return this.database.transaction(context, async (tx) => {
      const existing = await this.reviews.findById(tx, context, reviewId);
      if (!existing || existing.documentId !== documentId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'review_not_found');
      }
      if (existing.decidedAt !== null || existing.state !== 'pending') {
        throw new ApiError(
          409,
          'conflict',
          'This review has already been decided',
          undefined,
          'review_already_decided',
        );
      }

      const moved = await this.reviews.decide(tx, context, {
        reviewId,
        state: input.state,
        note: input.note,
      });
      if (moved === 0) {
        // Lost a race to another decision between the read and the update.
        throw new ApiError(
          409,
          'conflict',
          'This review has already been decided',
          undefined,
          'review_already_decided',
        );
      }

      const decided = await this.reviews.findById(tx, context, reviewId);
      return toView(decided as DocReviewRow);
    });
  }

  /** The maximum note length the controller validates against. */
  static get maxNoteLength(): number {
    return MAX_NOTE_LENGTH;
  }
}
