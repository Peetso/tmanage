import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { InsightSavedViewsRepository } from '../src/modules/insights/saved-views.repository.js';
import { InsightSnapshotsRepository } from '../src/modules/insights/snapshots.repository.js';
import { InsightMetricAlertsRepository } from '../src/modules/insights/metric-alerts.repository.js';
import { InsightCustomReportsRepository } from '../src/modules/insights/custom-reports.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Insights persistence stores (module 15): saved views (0089), snapshots (0090), metric alerts
 * (0187) and custom reports (0188) against a real server and the adversarial near-identical tenant
 * pair the isolation corpus uses. Three postures are exercised across the four stores:
 *
 *  - CRUD round-trips: a scoped create/insert/upsert reads back through the repository's own scoped
 *    read; a replace moves only the editable fields and an upsert is idempotent in place.
 *  - Tenant isolation: the twin's id differs from Northstar's in the final hex digit only, so a
 *    missing `organization_id` predicate would leak the twin's row rather than fail — every
 *    cross-tenant read must return nothing, and the reverse direction must still find its own row.
 *  - Owner/member scoping (the repository's permission denial): the per-member stores scope every
 *    read and write to the acting user, so one member never reads, replaces or deletes another
 *    member's private row even inside the same tenant.
 *
 * A final case proves the layer-3 guard is genuinely on the Drizzle path: an unscoped
 * `SELECT ... FROM insight_saved_views` still throws and names the table.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let northstarManager: TenantContext;
let twin: TenantContext;

const savedViews = new InsightSavedViewsRepository();
const snapshots = new InsightSnapshotsRepository();
const metricAlerts = new InsightMetricAlertsRepository();
const customReports = new InsightCustomReportsRepository();

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
  northstarManager = contextFor(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('insight saved views (0089)', () => {
  it('round-trips a create through the owner-scoped read and never sees the twin’s view', async () => {
    const id = await tenant.transaction(northstar, (tx) =>
      savedViews.create(tx, northstar, {
        name: 'Weekly delivery',
        reportKind: 'delivery-flow',
        filters: { state: 'in_progress' },
      }),
    );

    const found = await tenant.read(northstar, (tx) => savedViews.findOwn(tx, northstar, id));
    expect(found?.id).toBe(id);
    expect(found?.organizationId).toBe(northstar.organizationId);
    expect(found?.ownerUserId).toBe(world.northstar.owner.id);
    expect(found?.filters).toEqual({ state: 'in_progress' });

    // A view created in the twin with an identical shape must not resolve in Northstar.
    const twinId = await tenant.transaction(twin, (tx) =>
      savedViews.create(tx, twin, {
        name: 'Weekly delivery',
        reportKind: 'delivery-flow',
        filters: { state: 'in_progress' },
      }),
    );
    const leak = await tenant.read(northstar, (tx) => savedViews.findOwn(tx, northstar, twinId));
    expect(leak).toBeNull();
    const reallyExists = await tenant.read(twin, (tx) => savedViews.findOwn(tx, twin, twinId));
    expect(reallyExists?.id).toBe(twinId);
  });

  it('scopes list and delete to the owner: one member never reads or removes another’s view', async () => {
    const managerId = await tenant.transaction(northstarManager, (tx) =>
      savedViews.create(tx, northstarManager, {
        name: 'Manager private',
        reportKind: 'workload',
        filters: {},
      }),
    );

    // The owner's list excludes the manager's private view.
    const ownerList = await tenant.read(northstar, (tx) => savedViews.listOwn(tx, northstar));
    expect(ownerList.map((row) => row.id)).not.toContain(managerId);

    // The owner cannot delete the manager's view: nothing is removed and it still resolves for its
    // owner.
    const removed = await tenant.transaction(northstar, (tx) =>
      savedViews.deleteOwn(tx, northstar, managerId),
    );
    expect(removed).toBe(false);
    const stillThere = await tenant.read(northstarManager, (tx) =>
      savedViews.findOwn(tx, northstarManager, managerId),
    );
    expect(stillThere?.id).toBe(managerId);
  });
});

describe('insight snapshots (0090)', () => {
  it('inserts with the bound captured_at and reads it back, scoped to the tenant', async () => {
    const id = uuidv7();
    const capturedAt = new Date('2026-03-01T12:00:00.000Z');
    await tenant.transaction(northstar, (tx) =>
      snapshots.insert(tx, northstar, {
        id,
        kind: 'workload',
        capturedAt,
        payload: { open_items: 7 },
      }),
    );

    const found = await tenant.read(northstar, (tx) => snapshots.findById(tx, northstar, id));
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe('workload');
    expect(found?.capturedAt.getTime()).toBe(capturedAt.getTime());
    expect(found?.payloadJson).toEqual({ open_items: 7 });

    // A cross-tenant id must not resolve (the service maps undefined to a 404).
    const leak = await tenant.read(twin, (tx) => snapshots.findById(tx, twin, id));
    expect(leak).toBeUndefined();
  });

  it('lists a tenant’s snapshots of one kind newest-first and never the twin’s', async () => {
    const older = uuidv7();
    const newer = uuidv7();
    await tenant.transaction(northstar, async (tx) => {
      await snapshots.insert(tx, northstar, {
        id: older,
        kind: 'portfolio',
        capturedAt: new Date('2026-04-01T00:00:00.000Z'),
        payload: { active_projects: 1 },
      });
      await snapshots.insert(tx, northstar, {
        id: newer,
        kind: 'portfolio',
        capturedAt: new Date('2026-04-02T00:00:00.000Z'),
        payload: { active_projects: 2 },
      });
    });
    // A twin portfolio snapshot that must not appear in Northstar's list.
    await tenant.transaction(twin, (tx) =>
      snapshots.insert(tx, twin, {
        id: uuidv7(),
        kind: 'portfolio',
        capturedAt: new Date('2026-04-03T00:00:00.000Z'),
        payload: { active_projects: 99 },
      }),
    );

    const listed = await tenant.read(northstar, (tx) =>
      snapshots.list(tx, northstar, 'portfolio', 10),
    );
    const ids = listed.map((row) => row.id);
    expect(ids.slice(0, 2)).toEqual([newer, older]);
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });
});

describe('insight metric alerts (0187)', () => {
  it('upserts idempotently in place and keeps alerts self-scoped to the member', async () => {
    await tenant.transaction(northstar, (tx) =>
      metricAlerts.upsert(tx, northstar, {
        memberUserId: world.northstar.owner.id,
        metricKey: 'open_items',
        comparator: 'gte',
        threshold: 10,
      }),
    );
    // Re-setting the same (member, metric) replaces comparator/threshold rather than inserting.
    await tenant.transaction(northstar, (tx) =>
      metricAlerts.upsert(tx, northstar, {
        memberUserId: world.northstar.owner.id,
        metricKey: 'open_items',
        comparator: 'lte',
        threshold: 20,
      }),
    );

    const ownerAlerts = await tenant.read(northstar, (tx) =>
      metricAlerts.listForMember(tx, northstar, world.northstar.owner.id),
    );
    const openItems = ownerAlerts.filter((row) => row.metricKey === 'open_items');
    expect(openItems).toHaveLength(1);
    const openItemsAlert = openItems[0];
    expect(openItemsAlert?.comparator).toBe('lte');
    expect(openItemsAlert?.threshold).toBe(20);

    // The manager, acting for themselves, sees none of the owner's alerts.
    const managerAlerts = await tenant.read(northstarManager, (tx) =>
      metricAlerts.listForMember(tx, northstarManager, world.northstar.manager.id),
    );
    expect(managerAlerts).toHaveLength(0);
  });

  it('does not leak a member’s alert across the tenant boundary', async () => {
    await tenant.transaction(twin, (tx) =>
      metricAlerts.upsert(tx, twin, {
        memberUserId: world.twin.owner.id,
        metricKey: 'active_projects',
        comparator: 'gte',
        threshold: 3,
      }),
    );

    // Northstar's owner shares no alert with the twin; a scoped read in Northstar is empty for the
    // twin owner's id (which is one hex digit from Northstar's owner id).
    const leak = await tenant.read(northstar, (tx) =>
      metricAlerts.listForMember(tx, northstar, world.twin.owner.id),
    );
    expect(leak).toHaveLength(0);
  });
});

describe('insight custom reports (0188)', () => {
  it('creates, replaces editable fields in place, and deletes, scoped to the owner', async () => {
    const id = await tenant.transaction(northstar, (tx) =>
      customReports.create(tx, northstar, {
        name: 'Load overview',
        metricKeys: ['open_items', 'active_assignees'],
        layout: 'list',
      }),
    );

    const replaced = await tenant.transaction(northstar, (tx) =>
      customReports.replaceOwn(tx, northstar, id, {
        name: 'Load overview v2',
        metricKeys: ['active_projects'],
        layout: 'grid',
      }),
    );
    expect(replaced).toBe(true);

    const found = await tenant.read(northstar, (tx) => customReports.findOwn(tx, northstar, id));
    expect(found?.name).toBe('Load overview v2');
    expect(found?.metricKeys).toEqual(['active_projects']);
    expect(found?.layout).toBe('grid');
    expect(found?.ownerUserId).toBe(world.northstar.owner.id);

    const removed = await tenant.transaction(northstar, (tx) =>
      customReports.deleteOwn(tx, northstar, id),
    );
    expect(removed).toBe(true);
    const gone = await tenant.read(northstar, (tx) => customReports.findOwn(tx, northstar, id));
    expect(gone).toBeNull();
  });

  it('refuses a non-owner replace and a cross-tenant lookup', async () => {
    const id = await tenant.transaction(northstar, (tx) =>
      customReports.create(tx, northstar, {
        name: 'Owner only',
        metricKeys: ['open_items'],
        layout: 'list',
      }),
    );

    // The manager cannot replace the owner's report: nothing is updated and the row is unchanged.
    const replaced = await tenant.transaction(northstarManager, (tx) =>
      customReports.replaceOwn(tx, northstarManager, id, {
        name: 'Hijacked',
        metricKeys: ['scheduled_items'],
        layout: 'grid',
      }),
    );
    expect(replaced).toBe(false);
    const unchanged = await tenant.read(northstar, (tx) =>
      customReports.findOwn(tx, northstar, id),
    );
    expect(unchanged?.name).toBe('Owner only');

    // The twin cannot read the report by id.
    const leak = await tenant.read(twin, (tx) => customReports.findOwn(tx, twin, id));
    expect(leak).toBeNull();
  });
});

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('throws when a query over an insight store omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { insightSavedViews } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(insightSavedViews);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['insight_saved_views']);
  });
});
