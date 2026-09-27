import { and, asc, eq, gt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docReviews, memberships } from '../../common/database/schema.js';
import type { DocReviewRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The doc-reviews repository — Docs review workflow (x313), following the
 * `document-comments`/`documents` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the sibling
 * repositories honour it: every method's first two parameters are the `TenantQueryRunner` and the
 * `TenantContext`, there is no unscoped overload, the tenant comes from the context and never from a
 * DTO, and the tenant predicate is on every statement so a forgotten one throws rather than leaking
 * rows. The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** No `organizationId` — it is taken from the context, so there is no field for a body to populate. */
export interface CreateDocReviewInput {
  readonly documentId: string;
  /** The membership the request is made under — the service passes `context.membershipId`. */
  readonly requestedBy: string;
  /** The user asked to review — resolved to a member of this tenant before this insert. */
  readonly reviewerUserId: string;
  readonly note: string | null;
}

export interface ListDocReviewsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DocReviewsRepository {
  /**
   * True if `userId` is a member of the acting tenant.
   *
   * The reviewer is resolved tenant-scoped before a request is written, so an unknown or
   * cross-tenant user id is a 400 rather than a foreign-key error on insert (the composite
   * `fk_doc_reviews_reviewer_tenant` would refuse it, but a resolve-first keeps it a clean 400).
   */
  async reviewerIsMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.userId, userId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Fetch one review by id, within the acting tenant. No unscoped form. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    reviewId: string,
  ): Promise<DocReviewRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(docReviews)
      .where(and(eq(docReviews.organizationId, context.organizationId), eq(docReviews.id, reviewId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List one document's reviews, within the acting tenant, oldest first.
   *
   * Both `organization_id` and `document_id` predicates are present. Keyset pagination on `id`:
   * `(organization_id, document_id, id)` is the schema's list index and UUIDv7 ids sort in
   * creation order, so the walk is chronological without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    options: ListDocReviewsOptions = {},
  ): Promise<readonly DocReviewRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(docReviews.organizationId, context.organizationId),
      eq(docReviews.documentId, documentId),
    ];
    if (options.after) predicates.push(gt(docReviews.id, options.after));

    return db
      .select()
      .from(docReviews)
      .where(and(...predicates))
      .orderBy(asc(docReviews.id))
      .limit(limit);
  }

  /**
   * Create a pending review request.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The document and reviewer are *not* re-checked to belong to the tenant here:
   * the service resolves the document tenant-scoped and validates the reviewer's membership before
   * this insert (the Known trap), and the composite foreign keys refuse a cross-tenant pair besides.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDocReviewInput,
  ): Promise<DocReviewRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(docReviews).values({
      id,
      organizationId: context.organizationId,
      documentId: input.documentId,
      requestedBy: input.requestedBy,
      reviewerUserId: input.reviewerUserId,
      state: 'pending',
      note: input.note,
      createdAt: sql`current_timestamp(3)`,
    });

    const rows = await db
      .select()
      .from(docReviews)
      .where(and(eq(docReviews.organizationId, context.organizationId), eq(docReviews.id, id)))
      .limit(1);
    return rows[0] as DocReviewRow;
  }

  /**
   * Record a decision on a still-pending review, atomically.
   *
   * The `state = 'pending'` predicate is the concurrency guard: a review already decided by another
   * request updates zero rows here, so the service turns "no row moved" into the 409 without a
   * read-then-write race. Returns the number of rows affected.
   */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly reviewId: string;
      readonly state: 'approved' | 'changes_requested';
      readonly note: string | null;
    },
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(docReviews)
      .set({ state: input.state, note: input.note, decidedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(docReviews.organizationId, context.organizationId),
          eq(docReviews.id, input.reviewId),
          eq(docReviews.state, 'pending'),
        ),
      );
    // A review already decided (state != 'pending') moves zero rows; the service turns 0 into a 409.
    return result[0].affectedRows;
  }
}
