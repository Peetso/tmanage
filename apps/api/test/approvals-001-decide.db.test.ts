import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { DeliverableVersionsRepository } from '../src/modules/approvals/deliverable-versions.repository.js';
import { ClientProjectionsRepository } from '../src/modules/approvals/client-projections.repository.js';
import { ApprovalsService } from '../src/modules/approvals/approvals.service.js';
import { ApprovalNotFoundError } from '../src/modules/approvals/approvals.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FR-05 over a real server — the migration applies, and a tenant-scoped open→decide round-trips
 * with the hash re-check.
 *
 * The unit suite proves the decision behaviour with fakes; this proves the two things only MySQL
 * can: that `0027` produces the tables the service writes, and that a decision recorded through the
 * scoped `TenantDatabase` survives a read-back with the immutable actor, hash and time — and that a
 * governed content change made in the database invalidates the pending approval rather than
 * deciding it. The adversarial twin proves a cross-tenant approval never resolves.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;

const versions = new DeliverableVersionsRepository();
const approvalsRepo = new ApprovalsRepository();
let service: ApprovalsService;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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

/** An internal reviewer principal for a seeded user. */
function principal(
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

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** Create an immutable deliverable version for the Atlas project. */
async function createVersion(deliverableId: string, contentHash: string): Promise<string> {
  const row = await tenant.transaction(northstar, (tx) =>
    versions.create(tx, northstar, {
      projectId: world.northstar.projectId,
      deliverableId,
      contentHash,
      createdByUserId: world.northstar.manager.id,
    }),
  );
  return row.id;
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
    approvalsRepo,
    versions,
    new ClientProjectionsRepository(),
  );
});

afterAll(async () => {
  await db?.stop();
});

/** Omar is Northstar's manager and a member of the Atlas project — a valid assigned reviewer. */
function reviewer(): Principal {
  return principal(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
    'manager',
    [world.northstar.projectId],
    false,
  );
}

describe('FR-05 open→decide over a content-hashed version (0027)', () => {
  beforeEach(async () => {
    // The two new tables only; leave the seed world intact.
    await db.admin.query('DELETE FROM approvals');
    await db.admin.query('DELETE FROM deliverable_versions');
  });

  it('records an immutable approval over the current governed version', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);

    const opened = await service.open(northstar, reviewer(), {
      deliverableVersionId: versionId,
      reviewerIds: [world.northstar.manager.id],
    });
    expect(opened.state).toBe('requested');
    expect(opened.contentHash).toBe(HASH_A);

    const decided = await service.decide(northstar, reviewer(), opened.id, {
      decision: 'approve',
      expectedVersion: opened.version,
    });
    expect(decided.state).toBe('approved');
    expect(decided.decidedByUserId).toBe(world.northstar.manager.id);
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.contentHash).toBe(HASH_A);

    // The decision is durable and tenant-scoped in the row itself.
    const rows = await observe(
      'SELECT state, decided_by_user_id, content_hash FROM approvals WHERE id = ?',
      [opened.id],
    );
    expect(rows[0]?.['state']).toBe('approved');
    expect(rows[0]?.['decided_by_user_id']).toBe(world.northstar.manager.id);
  });

  it('invalidates a pending approval when the governed content changed (INT-17)', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);

    const opened = await service.open(northstar, reviewer(), {
      deliverableVersionId: versionId,
      reviewerIds: [world.northstar.manager.id],
    });

    // Governed content changes: a NEW version of the same deliverable, with a different hash.
    await createVersion(deliverableId, HASH_B);

    const decided = await service.decide(northstar, reviewer(), opened.id, {
      decision: 'approve',
      expectedVersion: opened.version,
    });
    expect(decided.state).toBe('invalidated');
    expect(decided.decidedByUserId).toBeNull();
    expect(decided.invalidationReason).not.toBeNull();
  });

  it('never resolves a cross-tenant approval', async () => {
    const deliverableId = uuidv7();
    const versionId = await createVersion(deliverableId, HASH_A);
    const opened = await service.open(northstar, reviewer(), {
      deliverableVersionId: versionId,
      reviewerIds: [world.northstar.manager.id],
    });

    const foreign = principal(
      world.twin.organizationId,
      world.twin.owner.id,
      world.twin.owner.membershipId,
      'owner',
      [],
      true,
    );

    await expect(
      service.decide(twin, foreign, opened.id, {
        decision: 'approve',
        expectedVersion: opened.version,
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });
});
