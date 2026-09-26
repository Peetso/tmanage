import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { ProjectObjectivesRepository } from '../src/modules/projects/project-objectives.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PROJ / module 8 (x124). The project-objectives repository against a real server and the adversarial
 * near-identical tenant pair the isolation corpus uses. Under test: a tenant-scoped objective
 * round-trips (create then a scoped list/findById, in creation order); the lifecycle UPDATE flips
 * `status` and the column-pinning trigger admits it; an objective never crosses a tenant boundary; and
 * the tenant guard is genuinely on the Drizzle path (an unscoped `SELECT ... FROM project_objectives`
 * still throws, naming the table). The pair's ids differ only in the final hex digit, so a missing
 * predicate would leak rather than pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const repository = new ProjectObjectivesRepository();

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

describe('a tenant-scoped objective round-trips and moves through its lifecycle', () => {
  it('creates in the acting tenant, lists in creation order, and transitions open → met', async () => {
    const first = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        name: 'First objective',
        description: 'The first thing we set out to do.',
        target: '≤ 3 days',
        status: 'open',
        createdBy: world.northstar.owner.id,
      }),
    );
    const second = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        name: 'Second objective',
        status: 'open',
        createdBy: world.northstar.owner.id,
      }),
    );

    expect(first.organizationId).toBe(northstar.organizationId);
    expect(first.status).toBe('open');
    expect(first.description).toBe('The first thing we set out to do.');
    expect(second.description).toBeNull();
    expect(second.target).toBeNull();
    expect(first.createdAt).toBeInstanceOf(Date);

    const listed = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.northstar.projectId }),
    );
    const ids = listed.map((row) => row.id);
    // Creation order (created_at ASC, id ASC).
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);

    // The lifecycle UPDATE: status moves and the column-pinning trigger admits it.
    const met = await tenant.transaction(northstar, (tx) =>
      repository.updateStatus(tx, northstar, first.id, 'met'),
    );
    expect(met.status).toBe('met');
    // Nothing else changed under the transition.
    expect(met.name).toBe('First objective');
    expect(met.createdBy).toBe(first.createdBy);
  });
});

describe('an objective never crosses a tenant boundary', () => {
  it('does not list the twin’s objective and returns null for a direct cross-tenant lookup', async () => {
    const twinObjective = await tenant.transaction(twin, (tx) =>
      repository.create(tx, twin, {
        projectId: world.twin.projectId,
        name: 'Twin objective',
        status: 'open',
        createdBy: world.twin.owner.id,
      }),
    );

    const mine = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.twin.projectId }),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinObjective.id);

    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, twinObjective.id),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) =>
      repository.findById(tx, twin, twinObjective.id),
    );
    expect(reallyExists?.id).toBe(twinObjective.id);
  });

  it('cannot be told which tenant to write into', async () => {
    // Structural, not runtime: `CreateProjectObjectiveInput` has no `organizationId`, so this is a
    // compile error and the @ts-expect-error fails the typecheck gate if the field is added.
    await tenant.transaction(northstar, async (tx) => {
      const created = await repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        name: 'Payload cannot choose the tenant',
        status: 'open',
        createdBy: world.northstar.owner.id,
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
        const { projectObjectives } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(projectObjectives);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['project_objectives']);
  });
});
