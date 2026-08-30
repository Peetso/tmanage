import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { syntheticWorkItemRows } from '@tmanage/test-kit';
import type { SyntheticWorkItemRow } from '@tmanage/test-kit';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEST-002's performance fixture — deterministic on purpose.
 *
 * A wall-clock assertion on a shared laptop is how flaky suites are born, and the standing
 * rule in this repository is that timing budgets come from measurement or not at all. So
 * "performance" here asserts the two things about performance that are *deterministic*:
 *
 * 1. **The plan.** At two thousand rows, the hot work-item reads must be index walks, not
 *    table scans — `EXPLAIN`'s `type` must not be `ALL`, and the index `07-DATA-MODEL` §9
 *    planned for the read must be among the candidates the optimiser saw. Which candidate
 *    an engine finally picks can differ between MySQL and MariaDB; *whether it scans* does
 *    not, and the scan is the regression this fixture exists to catch.
 * 2. **Correctness at volume.** The page cap holds at 200 exactly; a cursor walk over two
 *    thousand rows returns every row exactly once, in order; and the adversarial twin's
 *    five hundred rows are invisible at volume exactly as they are at three — the
 *    isolation corpus's claim, restated where an accidental `LIMIT`-less read would hurt.
 *
 * The data comes from `@tmanage/test-kit` — shaped load (states cycle, audiences vary,
 * due dates spread to both sides of now, a sixth undated), not one row copied. Inserted
 * here by the harness's admin credential, because test-kit is synthetic data only.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstarCtx: TenantContext;
let twinCtx: TenantContext;

const workItems = new WorkItemsRepository();

const NORTHSTAR_VOLUME = 1_500;
const TWIN_VOLUME = 500;

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });

async function bulkInsert(rows: readonly SyntheticWorkItemRow[]): Promise<void> {
  const CHUNK = 250;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = chunk
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, utc_timestamp(3), utc_timestamp(3))')
      .join(', ');
    const params = chunk.flatMap((row) => [
      row.id,
      row.organizationId,
      row.projectId,
      row.type,
      row.title,
      row.state,
      row.ownerUserId,
      row.audience,
      row.dueAt,
      row.version,
    ]);
    await db.admin.query(
      `insert into work_items
         (id, organization_id, project_id, type, title, state, owner_user_id, audience,
          due_at, version, created_at, updated_at)
       values ${values}`,
      params,
    );
  }
}

async function explain(sql: string, params: readonly unknown[]): Promise<RowDataPacket> {
  const [rows] = await db.admin.query<RowDataPacket[]>(`EXPLAIN ${sql}`, params as unknown[]);
  return rows[0] as RowDataPacket;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  northstarCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twinCtx = contextFor(
    world.twin.organizationId,
    world.twin.owner.id,
    world.twin.owner.membershipId,
  );

  const anchor = new Date();
  await bulkInsert(
    syntheticWorkItemRows({
      organizationId: world.northstar.organizationId,
      projectId: world.northstar.projectId,
      count: NORTHSTAR_VOLUME,
      anchor,
      label: 'Northstar load',
    }),
  );
  await bulkInsert(
    syntheticWorkItemRows({
      organizationId: world.twin.organizationId,
      projectId: world.twin.projectId,
      count: TWIN_VOLUME,
      anchor,
      label: 'Twin load',
    }),
  );
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('the plans, at volume', () => {
  it('the project/state list is an index walk, with §9 index among the candidates', async () => {
    const plan = await explain(
      `select id from work_items
        where organization_id = ? and project_id = ? and state = ?
        order by due_at limit 50`,
      [world.northstar.organizationId, world.northstar.projectId, 'in_progress'],
    );
    expect(String(plan['type'])).not.toBe('ALL');
    expect(plan['key']).not.toBeNull();
    expect(String(plan['possible_keys'])).toContain('ix_work_items_org_project_state_due');
  });

  it('the cursor page is an index walk over the (organization, id) key', async () => {
    const anchorRows = await db.admin.query<RowDataPacket[]>(
      `select id from work_items where organization_id = ? order by id limit 1`,
      [world.northstar.organizationId],
    );
    const firstId = String((anchorRows[0] as RowDataPacket[])[0]?.['id']);

    const plan = await explain(
      `select id from work_items
        where organization_id = ? and id > ?
        order by id limit 200`,
      [world.northstar.organizationId, firstId],
    );
    expect(String(plan['type'])).not.toBe('ALL');
    expect(plan['key']).not.toBeNull();
    expect(String(plan['possible_keys'])).toContain('uq_work_items_org_id');
  });
});

describe('correctness at volume', () => {
  it('the page cap is exactly 200, however much is behind it', async () => {
    const page = await tenant.read(northstarCtx, (runner) =>
      workItems.list(runner, northstarCtx, { limit: 100_000 }),
    );
    expect(page).toHaveLength(200);
  });

  it('a cursor walk returns every row exactly once, in order', async () => {
    const walked: string[] = [];
    let after: string | undefined;
    for (;;) {
      const cursor = after;
      const page = await tenant.read(northstarCtx, (runner) =>
        workItems.list(runner, northstarCtx, {
          projectId: world.northstar.projectId,
          limit: 200,
          ...(cursor === undefined ? {} : { after: cursor }),
        }),
      );
      walked.push(...page.map((row) => row.id));
      if (page.length < 200) break;
      after = page[page.length - 1]?.id;
    }

    // The volume plus the one item the seed world always places on this project.
    expect(walked).toHaveLength(NORTHSTAR_VOLUME + 1);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual(walked);
  });

  it('the twin’s five hundred rows are exactly as invisible as its three were', async () => {
    const walked: string[] = [];
    let after: string | undefined;
    for (;;) {
      const cursor = after;
      const page = await tenant.read(twinCtx, (runner) =>
        workItems.list(runner, twinCtx, {
          limit: 200,
          ...(cursor === undefined ? {} : { after: cursor }),
        }),
      );
      walked.push(...page.map((row) => row.id));
      if (page.length < 200) break;
      after = page[page.length - 1]?.id;
    }

    expect(walked).toHaveLength(TWIN_VOLUME + 1);

    const [northstarIds] = await db.admin.query<RowDataPacket[]>(
      `select id from work_items where organization_id = ?`,
      [world.northstar.organizationId],
    );
    const northstarSet = new Set(northstarIds.map((row) => String(row['id'])));
    for (const id of walked) expect(northstarSet.has(id)).toBe(false);
  });
});
