import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocSubscriptionsRepository } from './subscriptions.repository.js';

/**
 * DOC subscriptions (x312) — a member follows a document they can read, unfollows it, and lists their
 * own subscriptions. An explicit opt-in follow intent, distinct from `doc_bookmarks` (a personal saved
 * list) and a read-state marker (last-read position). A read-side flag only: this slice dispatches no
 * notifications. A per-membership surface kept in its own table `doc_subscriptions` and its own module,
 * so it touches no file another docs slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `doc.read` question a guard can answer with no object loaded — every
 * subscription route is `doc.read`, because a member follows a document they may *read*. This service
 * adds the object-level decision with the document's row in hand: it resolves the document
 * **tenant-scoped before** it authorizes (the Known-trap order — `DocumentsService.requireActionable`),
 * so a missing id, or one that belongs to another tenant, is a **404**, never a foreign-key 500 reached
 * by an org-wide caller who would pass the relation check regardless. A document the caller may not read
 * is also 404, never 403 — a 403 would confirm the document exists, which a non-member must not probe.
 *
 * The relation check is expressed with `work.read` rather than `doc.read`: `doc.read` was declared as a
 * ceiling-mirror of `work.read` (see `packages/domain`'s `capabilities.ts`), so the two are equal by
 * construction for every role, and `work.read` is what `authorize()` already relation-gates. This is the
 * exact reasoning `DocumentsService` and `DocBookmarksService` record.
 *
 * A subscription is always the caller's own: every write and the list are scoped to
 * `context.membershipId`, so a member can never create, remove, or read another member's subscriptions
 * even inside the same tenant. The subscriber is never taken from a body or a param.
 */

/**
 * What a caller sees of one followed document — paired Exact with the web's `DocSubscriptionSummary`.
 * `organizationId`/`membershipId` are deliberately absent — the wire projection never echoes the tenant
 * id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface DocSubscriptionView {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class DocSubscriptionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly subscriptions: DocSubscriptionsRepository = new DocSubscriptionsRepository(),
  ) {}

  /**
   * Resolve a document the principal may read, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not read, is 404 — never 403, never 500. Returns the
   * row so a caller can build the view without a second read.
   */
  private async requireReadable(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documentsRepo.findById(runner, context, documentId),
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

  /** Whether the caller is subscribed to a document they can read. */
  async status(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<{ readonly subscribed: boolean }> {
    await this.requireReadable(context, principal, documentId);
    const existing = await this.database.read(context, (runner) =>
      this.subscriptions.find(runner, context, documentId, context.membershipId),
    );
    return { subscribed: existing !== null };
  }

  /**
   * Subscribe the caller to a document, idempotently. A repeated PUT returns the same view, never a
   * second row. The document is resolved readable first (Known-trap 404 order).
   */
  async subscribe(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocSubscriptionView> {
    const document = await this.requireReadable(context, principal, documentId);
    const row = await this.database.transaction(context, (tx) =>
      this.subscriptions.add(tx, context, { documentId, membershipId: context.membershipId }),
    );
    return {
      id: row.id,
      documentId: row.documentId,
      title: document.title,
      projectId: document.projectId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Unsubscribe the caller from a document, idempotently (no subscription → still success). */
  async unsubscribe(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<void> {
    await this.requireReadable(context, principal, documentId);
    await this.database.transaction(context, (tx) =>
      this.subscriptions.remove(tx, context, documentId, context.membershipId),
    );
  }

  /**
   * List the caller's subscriptions, newest first, projected to the documents they can **still** read.
   * A followed document the caller has since lost read access to is dropped, so the list never leaks a
   * title the caller may no longer see.
   */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly DocSubscriptionView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.subscriptions.listForMember(runner, context, context.membershipId),
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
        documentId: row.documentId,
        title: row.title,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
