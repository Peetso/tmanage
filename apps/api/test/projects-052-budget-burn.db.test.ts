import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@tmanage/domain';
import { createBudgetBurnStore, createWorkerDatabase, sweepBudgetBurn } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 52-05 (0291) at the engine. Registry: both new tables are registered and granted as the brief
 * says. INT-52-11: after a sweep the cache equals the SUM of the time entries. INT-52-12: two
 * sweeps over the same usage raise one alert (the row lock and `last_alert_bp`).
 */

let db: TestDatabase;
let world: SeedWorld;
let workerDb: WorkerDatabase;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

beforeAll(async () => {
  db = await startTestDatabase();
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await workerDb?.end();
  await db.stop();
});

async function budget(minutes: number): Promise<void> {
  const ns = world.northstar;
  await db.admin.query(
    `INSERT INTO project_budgets
       (id, organization_id, project_id, budget_minutes, created_by, budget_type)
     VALUES (?, ?, ?, ?, ?, 'hours')`,
    [uuidv7(), ns.organizationId, ns.projectId, minutes, ns.owner.id],
  );
}

async function entry(minutes: number, rate: number | null): Promise<void> {
  const ns = world.northstar;
  await db.admin.query(
    `INSERT INTO work_item_time_logs
       (id, organization_id, work_item_id, project_id, logged_by, minutes, spent_on, created_at,
        rate_snapshot_minor)
     VALUES (?, ?, ?, ?, ?, ?, '2026-10-20', ?, ?)`,
    [
      uuidv7(),
      ns.organizationId,
      ns.workItemId,
      ns.projectId,
      ns.owner.membershipId,
      minutes,
      new Date('2026-10-20T10:00:00Z'),
      rate,
    ],
  );
}

describe('0291 — registry', () => {
  it('registers both tables and grants the worker what the sweep needs', () => {
    for (const table of ['project_budget_phases', 'budget_alert_events']) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
    }
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    expect(allows(worker, 'tmanage.project_budgets:UPDATE')).toBe(true);
    expect(allows(worker, 'tmanage.budget_alert_events:INSERT')).toBe(true);
    expect(allows(worker, 'tmanage.budget_alert_events:DELETE')).toBe(false);
  });
});

describe('INT-52-11 / INT-52-12 — the burn sweep', () => {
  it('leaves the cache equal to the SUM and raises one alert across two sweeps', async () => {
    await budget(600);
    await entry(300, 12_000);
    await entry(150, null);

    const first = await sweepBudgetBurn(createBudgetBurnStore(workerDb));
    const second = await sweepBudgetBurn(createBudgetBurnStore(workerDb));
    expect([first.alerts, second.alerts]).toEqual([1, 0]);

    const [rows] = (await db.admin.query(
      `SELECT used_minutes_cache, used_amount_cache_minor, last_alert_bp FROM project_budgets
        WHERE organization_id = ?`,
      [world.northstar.organizationId],
    )) as unknown as [
      { used_minutes_cache: number; used_amount_cache_minor: number; last_alert_bp: number }[],
    ];
    expect(rows[0]).toMatchObject({
      used_minutes_cache: 450,
      used_amount_cache_minor: 60_000,
      last_alert_bp: 7_000,
    });
    const [events] = (await db.admin.query(
      `SELECT threshold_bp FROM budget_alert_events WHERE organization_id = ?`,
      [world.northstar.organizationId],
    )) as unknown as [{ threshold_bp: number }[]];
    expect(events.map((e) => e.threshold_bp)).toEqual([7_000]);
  });
});
