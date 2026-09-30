import { describe, expect, it } from 'vitest';
import type { Principal, Role } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocReviewsService } from './reviews.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocReviewsRepository } from './reviews.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocReviewRow, DocumentRow } from '../../common/database/schema.js';

/**
 * Docs review workflow (x313) service proofs, database-free over the module's fakes and the *real*
 * `authorize()`. The migration and tenant-scoped SQL belong to the DB suite the chain owns; here the
 * subject is the service's permission and state logic: the happy request→decide→list path (no org
 * leak), and the three refusals the brief names — a reader without `doc.write` is **403** with no
 * insert, a decide on another tenant's document is **404** with no write even for an org-wide role,
 * and a re-decide of a decided review is **409**.
 *
 * The fake `findById` deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant document reaches the service and its `authorize()` guard must drop it — belt-and-braces.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const REVIEWER = 'user-0000-0000-0000-0000-000000000009';
const MEMBERSHIP = 'membership-0000-0000-000000000001';
const DOCUMENT = 'document-0000-0000-0000-000000000042';
const REVIEW = 'docreview-0000-0000-000000000001';

function principal(role: Role, projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = {
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

function seededDocument(organizationId = ORG): DocumentRow {
  return {
    id: DOCUMENT,
    organizationId,
    projectId: PROJECT,
    title: 'Kickoff brief',
    body: 'v0 body',
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DocumentRow;
}

function decidedReview(): DocReviewRow {
  return {
    id: REVIEW,
    organizationId: ORG,
    documentId: DOCUMENT,
    requestedBy: MEMBERSHIP,
    reviewerUserId: REVIEWER,
    state: 'approved',
    note: null,
    createdAt: new Date(),
    decidedAt: new Date(),
  } as DocReviewRow;
}

/** A service over in-memory stores whose document read omits the tenant scope on purpose. */
function serviceWith(options: {
  documents?: readonly DocumentRow[];
  reviews?: readonly DocReviewRow[];
  reviewerIsMember?: boolean;
}): { service: DocReviewsService; reviewStore: DocReviewRow[] } {
  const docStore: DocumentRow[] = [...(options.documents ?? [])];
  const reviewStore: DocReviewRow[] = [...(options.reviews ?? [])];
  let seq = 0;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const docRepo = {
    findById: async (_runner: unknown, _ctx: unknown, documentId: string) =>
      docStore.find((row) => row.id === documentId) ?? null,
  } as unknown as DocumentsRepository;

  const reviewRepo = {
    reviewerIsMember: async () => options.reviewerIsMember ?? true,
    findById: async (_runner: unknown, ctx: TenantContext, reviewId: string) =>
      reviewStore.find((r) => r.organizationId === ctx.organizationId && r.id === reviewId) ?? null,
    list: async (_runner: unknown, ctx: TenantContext, documentId: string) =>
      reviewStore
        .filter((r) => r.organizationId === ctx.organizationId && r.documentId === documentId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        documentId: string;
        requestedBy: string;
        reviewerUserId: string;
        note: string | null;
      },
    ) => {
      const row = {
        id: `docreview-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        documentId: input.documentId,
        requestedBy: input.requestedBy,
        reviewerUserId: input.reviewerUserId,
        state: 'pending',
        note: input.note,
        createdAt: new Date(),
        decidedAt: null,
      } as DocReviewRow;
      reviewStore.push(row);
      return row;
    },
    decide: async (
      _runner: unknown,
      _ctx: TenantContext,
      input: { reviewId: string; state: 'approved' | 'changes_requested'; note: string | null },
    ) => {
      const row = reviewStore.find((r) => r.id === input.reviewId && r.state === 'pending');
      if (!row) return 0;
      row.state = input.state;
      row.note = input.note;
      (row as { decidedAt: Date | null }).decidedAt = new Date();
      return 1;
    },
  } as unknown as DocReviewsRepository;

  return { service: new DocReviewsService(database, docRepo, reviewRepo), reviewStore };
}

describe('DocReviewsService', () => {
  it('requests then decides a review, and lists it back for a project member without leaking the org id', async () => {
    const { service } = serviceWith({ documents: [seededDocument()] });
    const author = principal('member', [PROJECT]);

    const requested = await service.request(context, author, DOCUMENT, {
      reviewerUserId: REVIEWER,
      note: null,
    });
    expect(requested.state).toBe('pending');
    expect(requested.decidedAt).toBeNull();
    expect(JSON.stringify(requested)).not.toContain(ORG);

    const decided = await service.decide(context, author, DOCUMENT, requested.id, {
      state: 'approved',
      note: null,
    });
    expect(decided.state).toBe('approved');
    expect(decided.decidedAt).not.toBeNull();

    const listed = await service.list(context, author, DOCUMENT);
    expect(listed.map((r) => r.state)).toEqual(['approved']);
  });

  it('refuses a request from a reader without doc.write as 403, and writes nothing', async () => {
    // A guest holds doc.read/work.read (can see the document) but not doc.write/work.create.
    const { service, reviewStore } = serviceWith({ documents: [seededDocument()] });
    const guest = principal('guest', [PROJECT]);

    const error = await service
      .request(context, guest, DOCUMENT, { reviewerUserId: REVIEWER, note: null })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(reviewStore).toHaveLength(0);
  });

  it('refuses a decide on another tenant’s document as 404 with no write, even for an org-wide role', async () => {
    const { service, reviewStore } = serviceWith({ documents: [seededDocument(OTHER_ORG)] });
    const error = await service
      .decide(context, principal('owner', [], true), DOCUMENT, REVIEW, {
        state: 'approved',
        note: null,
      })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(reviewStore).toHaveLength(0);
  });

  it('refuses to re-decide a review that was already decided as 409', async () => {
    const { service } = serviceWith({ documents: [seededDocument()], reviews: [decidedReview()] });
    const error = await service
      .decide(context, principal('member', [PROJECT]), DOCUMENT, REVIEW, {
        state: 'changes_requested',
        note: 'please revise',
      })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(409);
  });
});
