import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { ScheduleStatsService } from '../src/modules/work/schedule-stats.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 53-06 (0297) at the engine. Registry: the table is tenant-registered and granted to the app only.
 * PERF 53-T-16: a 2,000-item project with a chained graph recomputes in under 500 ms. The recompute
 * replaces the project's rows under one batch id, and another tenant's rows are never touched.
 */

let db: TestDatabase;
let world: SeedWorld;
let ctx: TenantContext;
let service: ScheduleStatsService;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  const ns = world.northstar;
  ctx = createTenantContext({
    organizationId: ns.organizationId,
    userId: ns.owner.id,
    membershipId: ns.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  service = new ScheduleStatsService(new TenantDatabase(db.runtime, { guardMode: 'enforce' }));
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

/** `n` items in a chain (each FS after the previous), one working day each from 2026-11-01. */
async function seedChain(n: number): Promise<string[]> {
  const ns = world.northstar;
  const ids = Array.from({ length: n }, () => uuidv7());
  const start = new Date('2026-11-01T06:00:00Z');
  for (let at = 0; at < n; at += 500) {
    const chunk = ids.slice(at, at + 500);
    await db.admin.query(
      `INSERT INTO work_items (id, organization_id, project_id, title, state, start_at, due_at)
       VALUES ?`,
      [
        chunk.map((id, i) => [
          id,
          ns.organizationId,
          ns.projectId,
          `Chain ${at + i}`,
          'todo',
          start,
          start,
        ]),
      ],
    );
  }
  const edges = ids
    .slice(1)
    .map((id, i) => [
      uuidv7(),
      ns.organizationId,
      id,
      ids[i],
      'FS',
      0,
      'ui',
      'active',
      ns.owner.id,
      new Date(),
    ]);
  for (let at = 0; at < edges.length; at += 500) {
    await db.admin.query(
      `INSERT INTO work_item_dependencies
         (id, organization_id, work_item_id, depends_on_work_item_id, kind, lag_working_days,
          created_source, status, created_by_user_id, created_at)
       VALUES ?`,
      [edges.slice(at, at + 500)],
    );
  }
  return ids;
}

describe('0297 — registry', () => {
  it('registers work_item_schedule_stats as a tenant table granted to the app only', () => {
    expect(Object.keys(TABLES)).toContain('work_item_schedule_stats');
    expect(TENANT_TABLES['work_item_schedule_stats']).toBe('organization_id');
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    expect(allows(app, 'tmanage.work_item_schedule_stats:DELETE')).toBe(true);
    expect(allows(worker, 'tmanage.work_item_schedule_stats:INSERT')).toBe(false);
  });
});

describe('53-06 recompute', () => {
  it('PERF 53-T-16: 2,000 chained items recompute in under 500 ms, one batch, one tenant', async () => {
    await seedChain(2000);
    await service.recompute(ctx, world.northstar.projectId); // warm the pool and the calendar read
    const started = performance.now();
    const outcome = await service.recompute(ctx, world.northstar.projectId);
    expect(performance.now() - started).toBeLessThan(500);
    expect(outcome.items).toBe(2000);

    const [rows] = await db.admin.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT batch_id) AS batches, SUM(is_critical) AS critical
         FROM work_item_schedule_stats WHERE organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(rows[0]).toMatchObject({ n: 2000, batches: 1 });
    expect(Number(rows[0]?.['critical'])).toBe(2000); // a single chain is critical end to end
    const [other] = await db.admin.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM work_item_schedule_stats WHERE organization_id <> ?`,
      [world.northstar.organizationId],
    );
    expect(Number(other[0]?.['n'])).toBe(0);
  });
});
