import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docSubscriptions, documents } from '../../common/database/schema.js';
import type { DocSubscriptionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC subscriptions (x312) — a membership's explicit follow list over `documents` rows. It owns the
 * subscribe insert, the unsubscribe delete, and the newest-first list of a membership's subscriptions
 * joined to their live documents. It follows the `doc_bookmarks` repository (x242) pattern and honours
 * `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddSubscriptionInput} has no
 *    `organizationId`, and the subscriber is `membershipId` from the context, never a param.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the check-then-insert on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddSubscriptionInput {
  readonly documentId: string;
  /** The subscribing membership — the service passes `context.membershipId`, never a body/param. */
  readonly membershipId: string;
}

/** One subscription joined to the document it follows, for the caller's list. */
export interface SubscribedDocumentRow {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: Date;
}

/** A membership's follow list carries the full document title, so a long list must not be unbounded. */
const MAX_SUBSCRIPTIONS_LISTED = 200;

export class DocSubscriptionsRepository {
  /** Fetch one membership's subscription to one document, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    membershipId: string,
  ): Promise<DocSubscriptionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docSubscriptions)
      .where(
        and(
          eq(docSubscriptions.organizationId, context.organizationId),
          eq(docSubscriptions.documentId, documentId),
          eq(docSubscriptions.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Subscribe a membership to a document, idempotently. If the subscription already exists it is
   * returned unchanged (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant
   * withholds UPDATE); otherwise a new row is inserted. The `(organization_id, document_id,
   * membership_id)` unique key is the guard: a racing insert that collides is caught and the existing
   * row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddSubscriptionInput,
  ): Promise<DocSubscriptionRow> {
    const existing = await this.find(runner, context, input.documentId, input.membershipId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(docSubscriptions).values({
        id,
        organizationId: context.organizationId,
        documentId: input.documentId,
        membershipId: input.membershipId,
        createdAt: new Date(),
      });
    } catch (error) {
      // A concurrent PUT won the unique key first; the subscription now exists, so re-read it and
      // treat this call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, input.documentId, input.membershipId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, input.documentId, input.membershipId);
    return inserted as DocSubscriptionRow;
  }

  /**
   * Remove a membership's subscription to a document, scoped to the acting tenant. Idempotent (no row
   * → no-op).
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    membershipId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(docSubscriptions)
      .where(
        and(
          eq(docSubscriptions.organizationId, context.organizationId),
          eq(docSubscriptions.documentId, documentId),
          eq(docSubscriptions.membershipId, membershipId),
        ),
      );
  }

  /**
   * List one membership's subscriptions, newest first, joined to the live document. The inner join
   * drops a subscription whose document no longer exists; the service further filters to documents the
   * caller can still read. Bounded.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly SubscribedDocumentRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: docSubscriptions.id,
        documentId: docSubscriptions.documentId,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: docSubscriptions.createdAt,
      })
      .from(docSubscriptions)
      .innerJoin(
        documents,
        and(
          eq(documents.organizationId, docSubscriptions.organizationId),
          eq(documents.id, docSubscriptions.documentId),
        ),
      )
      .where(
        and(
          eq(docSubscriptions.organizationId, context.organizationId),
          eq(docSubscriptions.membershipId, membershipId),
        ),
      )
      .orderBy(desc(docSubscriptions.createdAt), desc(docSubscriptions.id))
      .limit(MAX_SUBSCRIPTIONS_LISTED);
  }
}
