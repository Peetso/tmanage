import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { DocumentsRepository } from '../src/modules/docs/documents.repository.js';
import { DocReviewsService } from '../src/modules/docs/reviews.service.js';
import { DocSubscriptionsService } from '../src/modules/docs/subscriptions.service.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DOC-05 (x312 doc_subscriptions / x313 doc_reviews). The two deferred Docs slices — a member's
 * explicit follow list, and the request-and-decide review workflow — against a real server and the
 * adversarial near-identical tenant pair the isolation corpus is built on (migrations 0180/0181).
 *
 * `migrator.db.test.ts` proves the migrations apply; this proves only the behaviour the live tables
 * and the tenant-scoped services get right:
 *
 *  - **CRUD.** A subscription round-trips (subscribe → status → list → unsubscribe) and is idempotent
 *    (a repeated subscribe is the same row, never a second). A review round-trips (request → list →
 *    decide), the decision stamps `decided_at` once, and a second decide is a 409.
 *  - **Tenant isolation.** A document id belonging to the twin tenant does not resolve for a
 *    Northstar caller, so both subscribe and the review-list are a 404 with **no row written** — a
 *    cross-tenant reference is never created.
 *  - **Permission denial.** A guest holds `doc.read` but not `doc.write`: it may read the document,
 *    so requesting a review is a 403 (not a 404 — the honest split the service documents), while a
 *    request naming a reviewer who is not a member of the tenant is a 400.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let documentsRepo: DocumentsRepository;
let reviews: DocReviewsService;
let subscriptions: DocSubscriptionsService;

const contextFor = (
  organizationId: string,
  userId: string,
  membershipId: string,
  role: Role,
): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-10-17',
    correlationId: uuidv7(),
  });

/** An org-wide owner principal — passes the `work.read`/`work.create` relation for any of its projects. */
const ownerPrincipal = (
  organizationId: string,
  userId: string,
  membershipId: string,
): Principal => ({
  userId,
  organizationId,
  kind: 'internal',
  role: 'owner',
  membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
});

/**
 * A guest principal scoped to one project. A guest's role ceiling holds `doc.read`/`work.read` but
 * not `doc.write`/`work.create`, so it may read a document in a project it belongs to yet may not
 * originate a review on it.
 */
const guestPrincipal = (
  organizationId: string,
  userId: string,
  membershipId: string,
  projectId: string,
): Principal => ({
  userId,
  organizationId,
  kind: 'internal',
  role: 'guest',
  membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [projectId],
  hasOrgWideScope: false,
});

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return Number(rows[0]?.['n'] ?? 0);
}

/** Create a document in a project through the scoped repository, returning its id. */
async function createDocument(
  context: TenantContext,
  projectId: string,
  createdBy: string,
  title: string,
) {
  return tenant.transaction(context, (tx) =>
    documentsRepo.create(tx, context, {
      projectId,
      title,
      body: 'body prose',
      createdByUserId: createdBy,
    }),
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  documentsRepo = new DocumentsRepository();
  reviews = new DocReviewsService(tenant);
  subscriptions = new DocSubscriptionsService(tenant);
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

// ── Subscriptions (x312) ──────────────────────────────────────────────────────

describe('a subscription round-trips and is idempotent', () => {
  it('subscribes, reports status, lists it, and unsubscribes — a repeated subscribe is the same row', async () => {
    const ctx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const principal = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );
    const document = await createDocument(
      ctx,
      world.northstar.projectId,
      world.northstar.owner.id,
      'Kickoff brief',
    );

    expect((await subscriptions.status(ctx, principal, document.id)).subscribed).toBe(false);

    const first = await subscriptions.subscribe(ctx, principal, document.id);
    expect(first.documentId).toBe(document.id);
    expect(first.title).toBe('Kickoff brief');
    // Idempotent: the same membership subscribing again is the same row, never a second.
    const second = await subscriptions.subscribe(ctx, principal, document.id);
    expect(second.id).toBe(first.id);
    expect(await count('SELECT COUNT(*) AS n FROM doc_subscriptions')).toBe(1);

    expect((await subscriptions.status(ctx, principal, document.id)).subscribed).toBe(true);
    const listed = await subscriptions.list(ctx, principal);
    expect(listed.map((row) => row.documentId)).toContain(document.id);

    await subscriptions.unsubscribe(ctx, principal, document.id);
    expect((await subscriptions.status(ctx, principal, document.id)).subscribed).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM doc_subscriptions')).toBe(0);
  });
});

describe('a subscription never crosses a tenant boundary', () => {
  it('404s subscribing to the twin tenant’s document and writes no row', async () => {
    const northstarCtx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const northstarPrincipal = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );
    const twinCtx = contextFor(
      world.twin.organizationId,
      world.twin.owner.id,
      world.twin.owner.membershipId,
      'owner',
    );
    const twinDocument = await createDocument(
      twinCtx,
      world.twin.projectId,
      world.twin.owner.id,
      'Twin brief',
    );

    const error = await subscriptions
      .subscribe(northstarCtx, northstarPrincipal, twinDocument.id)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(await count('SELECT COUNT(*) AS n FROM doc_subscriptions')).toBe(0);
  });
});

// ── Reviews (x313) ──────────────────────────────────────────────────────────

describe('a review request is created, listed, and decided once', () => {
  it('requests a review, lists it pending, approves it, and refuses a second decision', async () => {
    const ctx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const principal = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );
    const document = await createDocument(
      ctx,
      world.northstar.projectId,
      world.northstar.owner.id,
      'Spec for review',
    );

    const requested = await reviews.request(ctx, principal, document.id, {
      reviewerUserId: world.northstar.manager.id,
      note: 'please review',
    });
    expect(requested.state).toBe('pending');
    expect(requested.requestedBy).toBe(world.northstar.owner.membershipId);
    expect(requested.reviewerUserId).toBe(world.northstar.manager.id);
    expect(requested.decidedAt).toBeNull();

    const listed = await reviews.list(ctx, principal, document.id);
    expect(listed.map((row) => row.id)).toContain(requested.id);

    const decided = await reviews.decide(ctx, principal, document.id, requested.id, {
      state: 'approved',
      note: null,
    });
    expect(decided.state).toBe('approved');
    expect(decided.decidedAt).not.toBeNull();

    // The decision is immutable: a second decide is a 409.
    const conflict = await reviews
      .decide(ctx, principal, document.id, requested.id, { state: 'changes_requested', note: 'no' })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect((conflict as ApiError).status).toBe(409);
    // The row still reflects the first decision only.
    expect(await count("SELECT COUNT(*) AS n FROM doc_reviews WHERE state = 'approved'")).toBe(1);
  });
});

describe('a review never crosses a tenant boundary', () => {
  it('404s listing reviews for the twin tenant’s document', async () => {
    const northstarCtx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const northstarPrincipal = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );
    const twinCtx = contextFor(
      world.twin.organizationId,
      world.twin.owner.id,
      world.twin.owner.membershipId,
      'owner',
    );
    const twinDocument = await createDocument(
      twinCtx,
      world.twin.projectId,
      world.twin.owner.id,
      'Twin spec',
    );

    const error = await reviews
      .list(northstarCtx, northstarPrincipal, twinDocument.id)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('requesting a review is permission-gated', () => {
  it('403s for a guest who may read the document but not write, writing no row', async () => {
    const ownerCtx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const document = await createDocument(
      ownerCtx,
      world.northstar.projectId,
      world.northstar.owner.id,
      'Guest-visible spec',
    );

    // The guest's membership id need not be real: requireWritableDocument throws before any write.
    const guestCtx = contextFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'guest',
    );
    const guest = guestPrincipal(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      world.northstar.projectId,
    );

    const error = await reviews
      .request(guestCtx, guest, document.id, {
        reviewerUserId: world.northstar.owner.id,
        note: null,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    // Scoped to this document: the denied request must write no review of it. (The shared
    // `truncateAll` does not clear `doc_reviews`, so a global count would see sibling tests' rows.)
    expect(
      await count('SELECT COUNT(*) AS n FROM doc_reviews WHERE document_id = ?', [document.id]),
    ).toBe(0);
  });

  it('400s when the named reviewer is not a member of the tenant', async () => {
    const ctx = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const principal = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );
    const document = await createDocument(
      ctx,
      world.northstar.projectId,
      world.northstar.owner.id,
      'Spec with bad reviewer',
    );

    // The twin owner is a real user, but not a member of the Northstar tenant.
    const error = await reviews
      .request(ctx, principal, document.id, {
        reviewerUserId: world.twin.owner.id,
        note: null,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    // Scoped to this document (see the 403 case): the rolled-back request writes no review of it.
    expect(
      await count('SELECT COUNT(*) AS n FROM doc_reviews WHERE document_id = ?', [document.id]),
    ).toBe(0);
  });
});
