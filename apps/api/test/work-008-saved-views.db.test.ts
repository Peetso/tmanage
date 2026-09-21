import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { SavedViewsRepository } from '../src/modules/work-views/saved-views.repository.js';
import type { SavedViewConfig } from '../src/common/database/schema.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * WK-08 (x107). The saved-views repository against a real server and the adversarial
 * near-identical tenant pair the isolation corpus uses. Three things are under test: the migration
 * applies and a tenant-scoped view round-trips (create then a scoped findById/listForViewer), the
 * own-plus-shared visibility rule is what `listForViewer` returns, and the tenant guard is
 * genuinely on the Drizzle path (an unscoped `SELECT ... FROM saved_views` still throws). The
 * pair's ids differ only in the final hex digit, so a missing predicate would leak rather than pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const repository = new SavedViewsRepository();

const CONFIG: SavedViewConfig = {
  filters: [{ field: 'state', value: 'in_progress' }],
  grouping: null,
  columns: ['title', 'state'],
};

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

describe('a tenant-scoped saved view round-trips', () => {
  it('creates in the acting tenant and reads it back, scoped to org', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        ownerUserId: world.northstar.owner.id,
        projectId: world.northstar.projectId,
        name: 'My board',
        config: CONFIG,
        shared: false,
      }),
    );

    expect(created.organizationId).toBe(northstar.organizationId);
    expect(created.ownerUserId).toBe(world.northstar.owner.id);
    expect(created.config).toEqual(CONFIG);

    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, created.id),
    );
    expect(found?.id).toBe(created.id);

    const listed = await tenant.read(northstar, (tx) =>
      repository.listForViewer(tx, northstar, world.northstar.owner.id),
    );
    expect(listed.map((row) => row.id)).toContain(created.id);
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });

  it('updates the editable fields in place and preserves the config round-trip', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        ownerUserId: world.northstar.owner.id,
        projectId: null,
        name: 'Before',
        config: CONFIG,
        shared: false,
      }),
    );

    const updated = await tenant.transaction(northstar, (tx) =>
      repository.update(tx, northstar, created.id, {
        projectId: null,
        name: 'After',
        config: { filters: [], grouping: 'state', columns: ['title'] },
        shared: true,
      }),
    );
    expect(updated.name).toBe('After');
    expect(updated.shared).toBe(true);
    expect(updated.config).toEqual({ filters: [], grouping: 'state', columns: ['title'] });
  });
});

describe('own-plus-shared visibility', () => {
  it('returns the caller’s own views and colleagues’ shared views, never a colleague’s private one', async () => {
    const shared = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        ownerUserId: world.northstar.manager.id,
        projectId: null,
        name: 'Team board',
        config: CONFIG,
        shared: true,
      }),
    );
    const managerPrivate = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        ownerUserId: world.northstar.manager.id,
        projectId: null,
        name: 'Manager private',
        config: CONFIG,
        shared: false,
      }),
    );

    const forOwner = await tenant.read(northstar, (tx) =>
      repository.listForViewer(tx, northstar, world.northstar.owner.id),
    );
    const ids = forOwner.map((row) => row.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(managerPrivate.id);
  });
});

describe('a saved view never crosses a tenant boundary', () => {
  it('does not list the twin’s view and returns null for a direct cross-tenant lookup', async () => {
    const twinView = await tenant.transaction(twin, (tx) =>
      repository.create(tx, twin, {
        ownerUserId: world.twin.owner.id,
        projectId: world.twin.projectId,
        name: 'Twin board',
        config: CONFIG,
        shared: true,
      }),
    );

    const mine = await tenant.read(northstar, (tx) =>
      repository.listForViewer(tx, northstar, world.twin.owner.id),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinView.id);

    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, twinView.id),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) =>
      repository.findById(tx, twin, twinView.id),
    );
    expect(reallyExists?.id).toBe(twinView.id);
  });

  it('cannot be told which tenant to write into', async () => {
    // Structural, not runtime: `CreateSavedViewInput` has no `organizationId`, so this is a
    // compile error and the @ts-expect-error fails the typecheck gate if the field is added.
    await tenant.transaction(northstar, async (tx) => {
      const created = await repository.create(tx, northstar, {
        ownerUserId: world.northstar.owner.id,
        projectId: null,
        name: 'Payload cannot choose the tenant',
        config: CONFIG,
        shared: false,
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
        const { savedViews } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(savedViews);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['saved_views']);
  });
});
