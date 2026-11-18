import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { HomePinsController } from '../src/modules/home/home-pins.controller.js';
import { HomePinsRepository } from '../src/modules/home/home-pins.repository.js';
import { RecentItemsRepository } from '../src/modules/home/recent-items.repository.js';
import { ApiError } from '../src/common/http/errors.js';
import { RECENT_ITEMS_CAP } from '../src/common/database/schema.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * HOME / My Day — pinned items (migration 0050, `home_pinned_items`) and recently-viewed items
 * (migration 0192, `home_recent_items`) against a real MySQL server and the adversarial tenant pair.
 *
 * `home-005-saved-context.db.test.ts` proves the OLDER, per-user `saved_context` (0035) surface.
 * This file proves the two membership-scoped siblings it does not touch, and asserts only what the
 * live table, its triggers and its unique keys can get right — the behaviours the controller/service
 * fakes (`home-pins.controller.test.ts`, `recent-items.controller.test.ts`) cannot:
 *
 * Pins (0050):
 *  1. A membership-scoped pin round-trips through the real controller + real `authorize` + real DB —
 *     a work pin and a project pin resolve tenant-scoped, list, and unpin.
 *  2. `listForMembership` returns newest-first (the `ix_home_pinned_items_org_membership` order).
 *  3. The duplicate guard is the engine's: a second insert of the same pin collides on
 *     `uq_home_pinned_items_pin`, leaving exactly one row.
 *  4. The Known trap: a cross-tenant target id does not resolve, so the pin is a 404 with no row.
 *  5. Pins are private to a membership — another member neither lists nor can unpin one.
 *
 * Recents (0192):
 *  6. `recordView` is an idempotent upsert: a repeat view refreshes `viewed_at` in place, never a
 *     second row (`ON DUPLICATE KEY UPDATE` against `uq_home_recent_items_object`).
 *  7. The read is bounded to {@link RECENT_ITEMS_CAP}, newest-first — never an unbounded scan.
 *  8. Identity is immutable at the engine (the 0192 trigger): a direct update of `object_id` or
 *     `membership_id` is refused.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let pinsController: HomePinsController;
const pinsRepo = new HomePinsRepository();
const recentsRepo = new RecentItemsRepository();

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
  pinsController = new HomePinsController(tenant);
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('home_pinned_items (0050) — membership-scoped Home pins', () => {
  it('pins a work item and a project tenant-scoped, lists them, and unpins', async () => {
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

    const afterWork = await pinsController.create(context, principal, {
      targetKind: 'work',
      targetId: world.northstar.workItemId,
    });
    expect(afterWork.pins).toHaveLength(1);
    expect(afterWork.pins[0]).toMatchObject({
      targetKind: 'work',
      targetId: world.northstar.workItemId,
    });

    const afterProject = await pinsController.create(context, principal, {
      targetKind: 'project',
      targetId: world.northstar.projectId,
    });
    expect(afterProject.pins).toHaveLength(2);
    expect(afterProject.pins.map((pin) => pin.targetId)).toEqual(
      expect.arrayContaining([world.northstar.workItemId, world.northstar.projectId]),
    );
    expect(
      await count('SELECT COUNT(*) AS n FROM home_pinned_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(2);

    const workPinId = afterProject.pins.find((pin) => pin.targetKind === 'work')?.id as string;
    const afterUnpin = await pinsController.remove(context, principal, workPinId);
    expect(afterUnpin.pins).toHaveLength(1);
    expect(afterUnpin.pins[0]?.targetKind).toBe('project');
    expect(
      await count('SELECT COUNT(*) AS n FROM home_pinned_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);
  });

  it('lists a membership’s pins newest-first (the index order)', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    // Seeded through the admin connection with explicit, ordered created_at so the ordering is
    // deterministic rather than at the mercy of three same-millisecond inserts. target_id carries no
    // FK (0050), so arbitrary reference ids are legitimate rows.
    const first = uuidv7();
    const second = uuidv7();
    const third = uuidv7();
    const seedPin = async (targetId: string, createdAt: string): Promise<void> => {
      await db.admin.execute(
        `INSERT INTO home_pinned_items
           (id, organization_id, membership_id, target_kind, target_id, created_at)
         VALUES (?, ?, ?, 'work', ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.owner.membershipId,
          targetId,
          createdAt,
        ],
      );
    };
    await seedPin(first, '2026-09-01 10:00:00.000');
    await seedPin(second, '2026-09-02 10:00:00.000');
    await seedPin(third, '2026-09-03 10:00:00.000');

    const rows = await tenant.read(context, (runner) =>
      pinsRepo.listForMembership(runner, context, world.northstar.owner.membershipId),
    );
    expect(rows.map((row) => row.targetId)).toEqual([third, second, first]);
  });

  it('refuses a duplicate pin at the unique key, leaving one row', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const input = {
      membershipId: world.northstar.owner.membershipId,
      targetKind: 'work' as const,
      targetId: world.northstar.workItemId,
    };

    await tenant.transaction(context, (tx) => pinsRepo.insert(tx, context, input));
    // A second insert of the same (membership, kind, id) is a collision at
    // uq_home_pinned_items_pin — the engine is the guard, not a probe-then-insert race.
    await expect(
      tenant.transaction(context, (tx) => pinsRepo.insert(tx, context, input)),
    ).rejects.toThrow();

    expect(
      await count('SELECT COUNT(*) AS n FROM home_pinned_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);
  });

  it('404s pinning the twin tenant’s project id, with no row written (the Known trap)', async () => {
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

    const error = await pinsController
      .create(context, principal, { targetKind: 'project', targetId: world.twin.projectId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    // No row for either tenant — not under the caller's org, and (the Known trap's point) not a
    // cross-tenant reference under the twin's. Scoped by organization_id because `home_pinned_items`
    // is not in `truncateAll`'s list, so rows from earlier cases in this file (under prior, now
    // truncated orgs) persist; the ids are fresh per seed, so the current pair is clean.
    expect(
      await count('SELECT COUNT(*) AS n FROM home_pinned_items WHERE organization_id IN (?, ?)', [
        world.northstar.organizationId,
        world.twin.organizationId,
      ]),
    ).toBe(0);
  });

  it('keeps pins private: another member neither lists nor can unpin one', async () => {
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
    const afterPin = await pinsController.create(ownerContext, ownerP, {
      targetKind: 'work',
      targetId: world.northstar.workItemId,
    });
    const ownerPinId = afterPin.pins[0]?.id as string;

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
      projectIds: [world.northstar.projectId],
    };

    // The manager sees none of the owner's pins...
    const managerList = await pinsController.list(managerContext, managerP);
    expect(managerList.pins).toEqual([]);

    // ...and unpinning by the owner's pin id removes nothing (404), the pin undisturbed.
    const error = await pinsController
      .remove(managerContext, managerP, ownerPinId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(
      await count('SELECT COUNT(*) AS n FROM home_pinned_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);
  });
});

describe('home_recent_items (0192) — a membership’s recently-viewed references', () => {
  it('upserts a repeat view in place: refreshes viewed_at, never a second row', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const membershipId = world.northstar.owner.membershipId;
    const earlier = new Date('2026-09-10T08:00:00.000Z');
    const later = new Date('2026-09-10T09:30:00.000Z');

    await tenant.transaction(context, (tx) =>
      recentsRepo.recordView(tx, context, {
        membershipId,
        objectType: 'work',
        objectId: world.northstar.workItemId,
        viewedAt: earlier,
      }),
    );
    await tenant.transaction(context, (tx) =>
      recentsRepo.recordView(tx, context, {
        membershipId,
        objectType: 'work',
        objectId: world.northstar.workItemId,
        viewedAt: later,
      }),
    );

    expect(
      await count('SELECT COUNT(*) AS n FROM home_recent_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(1);
    const rows = await tenant.read(context, (runner) =>
      recentsRepo.listForMembership(runner, context, membershipId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.viewedAt.getTime()).toBe(later.getTime());
  });

  it('bounds the read to RECENT_ITEMS_CAP, newest-first, dropping the oldest', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const membershipId = world.northstar.owner.membershipId;
    const base = Date.parse('2026-09-15T00:00:00.000Z');

    // One more distinct object than the cap; viewed_at increases with i, so i=0 is the oldest.
    // FIX5 6d: the read lists only live targets, so each recent points at a real work item.
    const objectIds: string[] = [];
    for (let i = 0; i <= RECENT_ITEMS_CAP; i += 1) {
      const objectId = uuidv7();
      objectIds.push(objectId);
      await db.admin.query(
        `INSERT INTO work_items (id, organization_id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          objectId,
          world.northstar.organizationId,
          world.northstar.projectId,
          `Recent ${i}`,
          new Date(base),
          new Date(base),
        ],
      );
      await tenant.transaction(context, (tx) =>
        recentsRepo.recordView(tx, context, {
          membershipId,
          objectType: 'work',
          objectId,
          viewedAt: new Date(base + i * 1_000),
        }),
      );
    }
    expect(
      await count('SELECT COUNT(*) AS n FROM home_recent_items WHERE organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toBe(RECENT_ITEMS_CAP + 1);

    const rows = await tenant.read(context, (runner) =>
      recentsRepo.listForMembership(runner, context, membershipId),
    );
    expect(rows).toHaveLength(RECENT_ITEMS_CAP);
    // Newest-first: the last recorded object leads, the oldest (i=0) is dropped entirely.
    expect(rows[0]?.objectId).toBe(objectIds[RECENT_ITEMS_CAP]);
    expect(rows.map((row) => row.objectId)).not.toContain(objectIds[0]);
    const viewedTimes = rows.map((row) => row.viewedAt.getTime());
    expect(viewedTimes).toEqual([...viewedTimes].sort((a, b) => b - a));
  });

  it('holds identity immutable at the engine (the 0192 trigger)', async () => {
    const context = contextFor(
      world.northstar.organizationId,
      world.northstar.owner.id,
      world.northstar.owner.membershipId,
      'owner',
    );
    const membershipId = world.northstar.owner.membershipId;
    await tenant.transaction(context, (tx) =>
      recentsRepo.recordView(tx, context, {
        membershipId,
        objectType: 'work',
        objectId: world.northstar.workItemId,
        viewedAt: new Date('2026-09-20T12:00:00.000Z'),
      }),
    );
    const [idRows] = await db.admin.query<RowDataPacket[]>(
      'SELECT id FROM home_recent_items WHERE organization_id = ? LIMIT 1',
      [world.northstar.organizationId],
    );
    const rowId = String(idRows[0]?.['id']);

    await expect(
      db.admin.execute('UPDATE home_recent_items SET object_id = ? WHERE id = ?', [
        uuidv7(),
        rowId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute('UPDATE home_recent_items SET membership_id = ? WHERE id = ?', [
        world.northstar.manager.membershipId,
        rowId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
