import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { DocumentsRepository } from '../src/modules/docs/documents.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DOC-01 (x91). The documents repository against a real server and the adversarial near-identical
 * tenant pair the isolation corpus uses. Two things are under test: the migration applies and a
 * tenant-scoped document round-trips (a create then a scoped list/findById), and the tenant guard
 * is genuinely on the Drizzle path (an unscoped `SELECT ... FROM documents` still throws). The
 * pair's ids differ only in the final hex digit, so a missing predicate would leak rather than
 * pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const repository = new DocumentsRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant-scoped document round-trips', () => {
  it('creates in the acting tenant and reads it back, scoped to org and project', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Kickoff brief',
        body: 'the body prose',
        createdByUserId: world.northstar.owner.id,
      }),
    );

    expect(created.organizationId).toBe(northstar.organizationId);
    expect(created.title).toBe('Kickoff brief');
    expect(created.body).toBe('the body prose');

    const listed = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.northstar.projectId }),
    );
    expect(listed.map((row) => row.id)).toContain(created.id);
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });
});

describe('a document never crosses a tenant boundary', () => {
  it('does not list the twin’s document and returns null for a direct cross-tenant lookup', async () => {
    const twinDocument = await tenant.transaction(twin, (tx) =>
      repository.create(tx, twin, {
        projectId: world.twin.projectId,
        title: 'Twin brief',
        body: 'twin body',
        createdByUserId: world.twin.owner.id,
      }),
    );

    const mine = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.twin.projectId }),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinDocument.id);

    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, twinDocument.id),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) =>
      repository.findById(tx, twin, twinDocument.id),
    );
    expect(reallyExists?.id).toBe(twinDocument.id);
  });

  it('cannot be told which tenant to write into', async () => {
    // Structural, not runtime: `CreateDocumentInput` has no `organizationId`, so this is a
    // compile error and the @ts-expect-error fails the typecheck gate if the field is added.
    await tenant.transaction(northstar, async (tx) => {
      const created = await repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Payload cannot choose the tenant',
        body: 'body',
        createdByUserId: world.northstar.owner.id,
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      expect(created.organizationId).toBe(northstar.organizationId);
    });
  });
});

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('throws when a Drizzle query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { documents } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(documents);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['documents']);
  });
});
