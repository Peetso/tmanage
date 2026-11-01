import { authorize, extractMentionedUserIds } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentCommentsRepository } from './document-comments.repository.js';
import { DocumentSharingRepository } from './document-sharing.repository.js';
import type {
  DocumentCommentRowWithAnchor,
  ListDocumentCommentsOptions,
} from './document-comments.repository.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';

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
  /** The author's display name, resolved through this tenant's memberships; null if unresolvable. */
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
  /** R5: the body anchor (`mark[data-comment]`) this comment hangs on; null = general. */
  readonly anchorId: string | null;
  /** R5: the selected text when the comment was made. */
  readonly anchorQuote: string | null;
  /** R5: ISO-8601 instant the thread was resolved; null while open. */
  readonly resolvedAt: string | null;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `document_comments` in a future migration is invisible to every
 * caller until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(
  row: DocumentCommentRowWithAnchor,
  names: ReadonlyMap<string, string>,
): DocumentCommentView {
  return {
    id: row.id,
    documentId: row.documentId,
    authorMembershipId: row.authorMembershipId,
    authorName: names.get(row.authorMembershipId) ?? null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    anchorId: row.anchorId ?? null,
    anchorQuote: row.anchorQuote ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** `document_comments.body` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte max. */
const MAX_BODY_LENGTH = 60_000;

export class DocumentCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly comments: DocumentCommentsRepository = new DocumentCommentsRepository(),
    private readonly people: Pick<
      DocumentSharingRepository,
      'people'
    > = new DocumentSharingRepository(),
    /** CQ-12 (COL-05): optional so a suite can construct the service without the outbox. */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  /** Membership id -> display name, anchored on this tenant's memberships. */
  private async authorNames(
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<Map<string, string>> {
    const rows = await this.database.read(context, (runner) =>
      this.people.people(runner, context, { membershipIds }),
    );
    return new Map(rows.map((row) => [row.membershipId, row.displayName]));
  }

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
    const names = await this.authorNames(
      context,
      rows.map((row) => row.authorMembershipId),
    );
    return rows.map((row) => toView(row, names));
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
    anchor: { readonly anchorId: string | null; readonly anchorQuote: string | null } = {
      anchorId: null,
      anchorQuote: null,
    },
  ): Promise<DocumentCommentView> {
    const document = await this.requireActionable(context, principal, documentId, 'work.create');
    const row = await this.database.transaction(context, async (tx) => {
      const appended = await this.comments.append(tx, context, {
        documentId,
        body,
        authorMembershipId: context.membershipId,
        anchorId: anchor.anchorId,
        anchorQuote: anchor.anchorQuote,
      });
      // CQ-12 (COL-05): the document's author and the people the comment mentions are told by
      // the worker, which re-checks each one's access at delivery. Ids only — never the text.
      await this.outbox?.append(tx, context, {
        type: 'document.comment_created.v1',
        aggregateId: documentId,
        payload: {
          documentId,
          commentId: appended.id,
          projectId: document.projectId,
          authorUserId: context.userId,
          mentionedUserIds: extractMentionedUserIds(body).filter((id) => id !== context.userId),
        },
      });
      return appended;
    });
    return toView(row, await this.authorNames(context, [row.authorMembershipId]));
  }

  /**
   * R5: resolve (`resolved = true`) or reopen a comment thread. `doc.write`, relation-gated as
   * `work.create`; the document is resolved tenant-scoped first, and a comment that is not this
   * document's, or was soft-deleted, is the same 404.
   */
  async setResolved(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<DocumentCommentView> {
    await this.requireActionable(context, principal, documentId, 'work.create');
    const row = await this.database.transaction(context, (tx) =>
      this.comments.setResolved(
        tx,
        context,
        documentId,
        commentId,
        resolved ? context.userId : null,
      ),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toView(row, await this.authorNames(context, [row.authorMembershipId]));
  }

  /** The maximum comment body length the controller validates against before calling {@link add}. */
  static get maxBodyLength(): number {
    return MAX_BODY_LENGTH;
  }
}
