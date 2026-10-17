import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { OnboardingTourController } from '../src/modules/home/onboarding-tour.controller.js';
import { OnboardingTourRepository } from '../src/modules/home/onboarding-tour.repository.js';
import { ONBOARDING_TOUR } from '../src/modules/home/onboarding-tour.steps.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ON-10 guided-tour progress (migration's `onboarding_progress`) against a real MySQL server and the
 * two-tenant seed.
 *
 * `onboarding-tour.controller.test.ts` proves the route's safety over a FAKE repository — the Known
 * trap, own-principal, idempotency and the `work.read` metadata. This file proves the half that fake
 * cannot: the behaviours the live table, its unique key and its index order actually enforce, through
 * the real controller + real {@link OnboardingTourRepository} + real {@link TenantDatabase}.
 *
 *  1. A completion round-trips: the real controller writes one row through the tenant credential and
 *     the next read reports that step done with a real `completedAt`, every other step still false.
 *  2. Idempotency is the ENGINE's, not a lucky probe: a direct duplicate insert of the same
 *     (organization, membership, step) collides on `uq_onboarding_progress_step`, and re-completing
 *     through the controller leaves exactly one row.
 *  3. Progress is private to a membership: the manager's completion is invisible to the designer in
 *     the SAME tenant, and writes no row under the designer's membership.
 *  4. `listForMembership` returns completion order — `completed_at` ascending, `id` breaking ties —
 *     the `ix_onboarding_progress_org_membership` order, regardless of the order steps were written.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let controller: OnboardingTourController;
const repo = new OnboardingTourRepository();

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

/** A minimal acting principal — the tour routes read no resource, so only identity matters here. */
const principalFor = (
  organizationId: string,
  userId: string,
  membershipId: string,
  role: Role,
): Principal => ({
  userId,
  organizationId,
  kind: 'internal',
  role,
  membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: role === 'owner',
});

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return Number(rows[0]?.['n'] ?? 0);
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  controller = new OnboardingTourController(tenant);
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('onboarding_progress (ON-10) — a membership’s guided-tour completions', () => {
  it('round-trips a completion: the real controller writes one row and the next read reports it done', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );
    const principal = principalFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );

    const after = await controller.complete(context, principal, 'create_project');
    const created = after.steps.find((s) => s.step === 'create_project');
    expect(created?.completed).toBe(true);
    expect(created?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // Every other step of the fixed tour is still outstanding.
    expect(after.steps.filter((s) => s.completed)).toHaveLength(1);
    expect(after.steps).toHaveLength(ONBOARDING_TOUR.length);

    const listed = await controller.list(context, principal);
    expect(listed.steps.find((s) => s.step === 'create_project')?.completed).toBe(true);
    expect(listed.steps.filter((s) => s.completed)).toHaveLength(1);

    expect(
      await count(
        'SELECT COUNT(*) AS n FROM onboarding_progress WHERE organization_id = ? AND membership_id = ?',
        [world.northstar.organizationId, world.northstar.designer.membershipId],
      ),
    ).toBe(1);
  });

  it('holds idempotency at the engine: a duplicate insert collides, and re-completing leaves one row', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );
    const principal = principalFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );

    await controller.complete(context, principal, 'welcome');

    // A second row for the same (organization, membership, step) is a collision at
    // uq_onboarding_progress_step — the engine is the guard, not the repository's probe.
    await expect(
      db.admin.execute(
        `INSERT INTO onboarding_progress (id, organization_id, membership_id, step, completed_at)
         VALUES (?, ?, ?, 'welcome', current_timestamp(3))`,
        [uuidv7(), world.northstar.organizationId, world.northstar.designer.membershipId],
      ),
    ).rejects.toThrow();

    // Re-completing through the controller writes nothing and answers with the one completion.
    const again = await controller.complete(context, principal, 'welcome');
    expect(again.steps.filter((s) => s.completed)).toHaveLength(1);

    expect(
      await count(
        'SELECT COUNT(*) AS n FROM onboarding_progress WHERE organization_id = ? AND membership_id = ? AND step = ?',
        [world.northstar.organizationId, world.northstar.designer.membershipId, 'welcome'],
      ),
    ).toBe(1);
  });

  it('keeps progress private to a membership: the manager’s completion is invisible to the designer', async () => {
    const managerContext = contextFor(
      world.northstar.organizationId,
      world.northstar.manager.id,
      world.northstar.manager.membershipId,
      'manager',
    );
    const managerPrincipal = principalFor(
      world.northstar.organizationId,
      world.northstar.manager.id,
      world.northstar.manager.membershipId,
      'manager',
    );
    await controller.complete(managerContext, managerPrincipal, 'welcome');

    const designerContext = contextFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );
    const designerPrincipal = principalFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );

    // Same tenant, different membership — the designer sees nothing of the manager's tour.
    const designerView = await controller.list(designerContext, designerPrincipal);
    expect(designerView.steps.every((s) => s.completed === false)).toBe(true);

    expect(
      await count(
        'SELECT COUNT(*) AS n FROM onboarding_progress WHERE organization_id = ? AND membership_id = ?',
        [world.northstar.organizationId, world.northstar.designer.membershipId],
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM onboarding_progress WHERE organization_id = ? AND membership_id = ?',
        [world.northstar.organizationId, world.northstar.manager.membershipId],
      ),
    ).toBe(1);
  });

  it('lists a membership’s completions in completion order, id breaking ties (the index order)', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.designer.id,
      world.northstar.designer.membershipId,
      'member',
    );

    // Seed two completions through the admin connection with explicit, out-of-presentation-order
    // completed_at, so the ordering under test is completion time, not insertion or step order.
    const seedStep = async (step: string, completedAt: string): Promise<void> => {
      await db.admin.execute(
        `INSERT INTO onboarding_progress (id, organization_id, membership_id, step, completed_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.designer.membershipId,
          step,
          completedAt,
        ],
      );
    };
    // `explore_work` is presented AFTER `welcome`, but was completed first.
    await seedStep('explore_work', '2026-09-01 10:00:00.000');
    await seedStep('welcome', '2026-09-02 10:00:00.000');

    const rows = await tenant.read(context, (runner) =>
      repo.listForMembership(runner, context, world.northstar.designer.membershipId),
    );
    expect(rows.map((row) => row.step)).toEqual(['explore_work', 'welcome']);
  });
});
