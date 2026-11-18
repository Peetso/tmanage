import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { DeliverableVersionsRepository } from '../src/modules/approvals/deliverable-versions.repository.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { ClientProjectionsRepository } from '../src/modules/approvals/client-projections.repository.js';
import { ApprovalsService } from '../src/modules/approvals/approvals.service.js';
import type { ClientProjectionPayload } from '../src/common/database/schema.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FR-05's client projection over a real server — the `0031` migration applies, and a tenant-scoped
 * publish→read round-trips the frozen hash and the client-safe payload (x97).
 *
 * The unit suite proves the publish/read decisions with fakes; this proves the two things only
 * MySQL can: that `0031` produces the table the service writes, and that a projection published
 * through the scoped `TenantDatabase` reads back with the immutable hash and payload — and that the
 * UNIQUE (organization_id, deliverable_version_id) refuses a re-publish at the engine, not only in
 * the application. The adversarial twin proves a cross-tenant version never resolves.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;
let service: ApprovalsService;

const versions = new DeliverableVersionsRepository();

const HASH_A = 'a'.repeat(64);

const payload: ClientProjectionPayload = {
  title: 'Atlas Homepage Concept',
  summary: 'The approved direction for the booking hero.',
  milestoneState: 'in_review',
  forecastDate: '2026-10-15',
  publishedRisk: 'on_track',
  decision: 'approved',
  approvedContacts: ['salma.riad@atlas.example'],
};

function contextFor(organizationId: string, userId: string, membershipId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('manager'),
    policyVersion: '2026-09-20',
    correlationId: uuidv7(),
  });
}

function internal(
  organizationId: string,
  userId: string,
  membershipId: string,
  role: Role,
  projectIds: readonly string[],
  hasOrgWideScope: boolean,
): Principal {
  return {
    userId,
    organizationId,
    kind: 'internal',
    role,
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

function clientPrincipal(
  userId: string,
  membershipId: string,
  clientOrganizationId: string,
  projectIds: readonly string[],
): Principal {
  return {
    userId,
    organizationId: world.northstar.organizationId,
    kind: 'client',
    role: 'client_reviewer',
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId,
    projectIds,
    hasOrgWideScope: false,
  };
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

let versionCount = 0;

async function createVersion(deliverableId: string, contentHash: string): Promise<string> {
  const row = await tenant.transaction(northstar, (tx) =>
    versions.create(tx, northstar, {
      projectId: world.northstar.projectId,
      // Every version has its number (0211); one counter keeps them unique per deliverable.
      versionNo: (versionCount += 1),
      deliverableId,
      contentHash,
      createdByUserId: world.northstar.manager.id,
    }),
  );
  return row.id;
}

/** Omar is Northstar's manager and a member of the Atlas project — a valid internal publisher. */
function publisher(): Principal {
  return internal(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
    'manager',
    [world.northstar.projectId],
    false,
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
  service = new ApprovalsService(
    tenant,
    new ApprovalsRepository(),
    versions,
    new ClientProjectionsRepository(),
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('FR-05 publish→read client projection (0031)', () => {
  beforeEach(async () => {
    await db.admin.query('DELETE FROM client_projections');
    await db.admin.query('DELETE FROM approvals');
    await db.admin.query('DELETE FROM deliverable_versions');
  });

  it('freezes the governed version and reads it back, tenant-scoped, with the hash', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);

    const published = await service.publish(northstar, publisher(), {
      deliverableVersionId: versionId,
      projection: payload,
    });
    expect(published.contentHash).toBe(HASH_A);
    expect(published.publishedByUserId).toBe(world.northstar.manager.id);
    expect(published.projection).toEqual(payload);

    // The related Atlas client reads the frozen projection back through the client relation.
    const atlasReviewer = clientPrincipal(
      world.atlas.reviewer.id,
      world.atlas.reviewer.membershipId,
      world.atlas.clientOrganizationId,
      [world.northstar.projectId],
    );
    const read = await service.readProjection(northstar, atlasReviewer, versionId);
    expect(read.contentHash).toBe(HASH_A);
    expect(read.projection).toEqual(payload);

    // The row is durable and tenant-scoped in the database itself.
    const rows = await observe(
      'SELECT organization_id, content_hash FROM client_projections WHERE deliverable_version_id = ?',
      [versionId],
    );
    expect(rows[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(rows[0]?.['content_hash']).toBe(HASH_A);
  });

  it('refuses a re-publish of the same version at the engine (append-only)', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);

    await service.publish(northstar, publisher(), {
      deliverableVersionId: versionId,
      projection: payload,
    });

    const error = await service
      .publish(northstar, publisher(), { deliverableVersionId: versionId, projection: payload })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);

    // Exactly one projection exists for the version.
    const rows = await observe(
      'SELECT COUNT(*) AS n FROM client_projections WHERE deliverable_version_id = ?',
      [versionId],
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('refuses a read from a client outside the relation', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);
    await service.publish(northstar, publisher(), {
      deliverableVersionId: versionId,
      projection: payload,
    });

    // Meridian's reviewer belongs to a different client org and a different project.
    const meridianReviewer = clientPrincipal(
      world.meridian.reviewer.id,
      world.meridian.reviewer.membershipId,
      world.meridian.clientOrganizationId,
      [world.meridian.projectId],
    );
    const error = await service
      .readProjection(northstar, meridianReviewer, versionId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('never resolves a cross-tenant version on publish', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);

    const foreign = internal(
      world.twin.organizationId,
      world.twin.owner.id,
      world.twin.owner.membershipId,
      'owner',
      [],
      true,
    );

    const error = await service
      .publish(twin, foreign, { deliverableVersionId: versionId, projection: payload })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);

    // Nothing was written in either tenant.
    const rows = await observe('SELECT COUNT(*) AS n FROM client_projections');
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});
