import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { HomeService } from '../src/modules/home/home.service.js';
import { MyDayRepository } from '../src/modules/home/my-day.repository.js';
import { WaitingRepository } from '../src/modules/home/waiting.repository.js';
import { SavedContextRepository } from '../src/modules/home/saved-context.repository.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * HOME-05 saved/pinned context against a real server and the adversarial tenant pair.
 *
 * The migration is proven applied by `migrator.db.test.ts`; this proves the behaviour only the
 * live table and the tenant-scoped resolve can get right:
 *
 * 1. A tenant + user scoped pin round-trips — pin, list grouped by project, unpin — and is
 *    idempotent.
 * 2. The Known trap: an entity or project id from the twin tenant does not resolve, so the pin is
 *    a 404 with **no row written**, never a cross-tenant reference.
 * 3. Pins are private: one user never sees or removes another's, even in the same tenant.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: HomeService;

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
    policyVersion: '2026-09-21',
    correlationId: uuidv7(),
  });

/** An org-wide owner principal — passes the `work.read` relation for any of its tenant's projects. */
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

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return Number(rows[0]?.['n'] ?? 0);
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new HomeService(
    tenant,
    new MyDayRepository(),
    new WaitingRepository(),
    new SavedContextRepository(),
  );
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('a tenant + user scoped pin round-trips', () => {
  it('pins a work item, lists it grouped by project, and unpins it', async () => {
    const context = contextFor(
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

    const afterPin = await service.pinContext(context, principal, {
      entityType: 'work',
      entityId: world.northstar.workItemId,
      projectId: world.northstar.projectId,
    });

    expect(afterPin.groups).toHaveLength(1);
    expect(afterPin.groups[0]?.projectId).toBe(world.northstar.projectId);
    expect(afterPin.groups[0]?.items).toHaveLength(1);
    expect(afterPin.groups[0]?.items[0]).toMatchObject({
      entityType: 'work',
      entityId: world.northstar.workItemId,
    });

    // Idempotent: pinning again writes no second row.
    await service.pinContext(context, principal, {
      entityType: 'work',
      entityId: world.northstar.workItemId,
      projectId: world.northstar.projectId,
    });
    expect(
      await count('SELECT COUNT(*) AS n FROM saved_context WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);

    const pinId = afterPin.groups[0]?.items[0]?.id as string;
    const afterUnpin = await service.unpinContext(context, principal, pinId);
    expect(afterUnpin.groups).toEqual([]);
    expect(
      await count('SELECT COUNT(*) AS n FROM saved_context WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(0);
  });
});

describe('the Known trap — cross-tenant ids do not resolve and nothing is written', () => {
  it('404s pinning the twin tenant’s project id, with no row written', async () => {
    const context = contextFor(
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

    const error = await service
      .pinContext(context, principal, {
        entityType: 'work',
        entityId: world.twin.workItemId,
        projectId: world.twin.projectId,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);

    expect(await count('SELECT COUNT(*) AS n FROM saved_context')).toBe(0);
  });

  it('404s pinning the twin’s work item under the caller’s own project (entity not in project)', async () => {
    const context = contextFor(
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

    const error = await service
      .pinContext(context, principal, {
        entityType: 'work',
        entityId: world.twin.workItemId,
        projectId: world.northstar.projectId,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(await count('SELECT COUNT(*) AS n FROM saved_context')).toBe(0);
  });
});

describe('pins are private to their user', () => {
  it('does not surface another user’s pin, and refuses to unpin it', async () => {
    const ownerContext = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const ownerP = ownerPrincipal(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
    );

    const afterPin = await service.pinContext(ownerContext, ownerP, {
      entityType: 'work',
      entityId: world.northstar.workItemId,
      projectId: world.northstar.projectId,
    });
    const ownerPinId = afterPin.groups[0]?.items[0]?.id as string;

    // The manager (a different user in the same tenant) sees none of the owner's pins...
    const managerContext = contextFor(
      world.northstar.organizationId,
      world.northstar.manager.id,
      world.northstar.manager.membershipId,
      'manager',
    );
    const managerP: Principal = {
      ...ownerPrincipal(
        world.northstar.organizationId,
        world.northstar.manager.id,
        world.northstar.manager.membershipId,
      ),
      role: 'manager',
      hasOrgWideScope: false,
      projectIds: [world.northstar.projectId, world.northstar.otherProjectId],
    };
    const managerList = await service.listSavedContext(managerContext, managerP);
    expect(managerList.groups).toEqual([]);

    // ...and cannot unpin one that is not theirs.
    const error = await service
      .unpinContext(managerContext, managerP, ownerPinId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(
      await count('SELECT COUNT(*) AS n FROM saved_context WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);
  });
});
