import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@tmanage/domain';
import { createFinanceFactsStore, createWorkerDatabase } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 52-14 (0296) at the engine. Registry: `finance_daily_facts` is registered and granted as the
 * brief says (no UPDATE for either principal). INT-52-25: two rebuilds of the same window write
 * the same facts, and their sums equal the live SUM over the time logs and approved expenses.
 * AUTH-52-14 (cost keys, person reports, range, throttle) is covered by the unit suite.
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

async function entry(minutes: number, billable: 0 | 1, rate: number | null, cost: number | null) {
  const ns = world.northstar;
  await db.admin.query(
    `INSERT INTO work_item_time_logs
       (id, organization_id, work_item_id, project_id, logged_by, minutes, spent_on, created_at,
        billable, rate_snapshot_minor, cost_snapshot_minor)
     VALUES (?, ?, ?, ?, ?, ?, '2026-10-20', ?, ?, ?, ?)`,
    [
      uuidv7(),
      ns.organizationId,
      ns.workItemId,
      ns.projectId,
      ns.owner.membershipId,
      minutes,
      new Date('2026-10-20T10:00:00Z'),
      billable,
      rate,
      cost,
    ],
  );
}

async function expense(amountBase: number, markupBp: number, state: string) {
  const ns = world.northstar;
  const at = new Date('2026-10-20T10:00:00Z');
  await db.admin.query(
    `INSERT INTO expenses
       (id, organization_id, project_id, membership_id, spent_on, category, amount_minor, currency,
        amount_base_minor, billable, markup_bp, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-10-20', 'travel', ?, 'SAR', ?, 1, ?, ?, ?, ?)`,
    [
      uuidv7(),
      ns.organizationId,
      ns.projectId,
      ns.owner.membershipId,
      amountBase,
      amountBase,
      markupBp,
      state,
      at,
      at,
    ],
  );
}

type Sums = { billed: string; cost: string; expense: string; billable: string; unpriced: string };

async function factSums(): Promise<Sums> {
  const [rows] = (await db.admin.query(
    `SELECT SUM(billed_minor) AS billed, SUM(cost_minor) AS cost, SUM(expense_minor) AS expense,
            SUM(billable_minutes) AS billable, SUM(unpriced_minutes) AS unpriced
       FROM finance_daily_facts WHERE organization_id = ?`,
    [world.northstar.organizationId],
  )) as unknown as [Sums[]];
  return rows[0] as Sums;
}

describe('0296 — registry', () => {
  it('registers the table and grants SELECT, INSERT, DELETE (never UPDATE)', () => {
    expect(Object.keys(TABLES)).toContain('finance_daily_facts');
    expect(TENANT_TABLES['finance_daily_facts']).toBe('organization_id');
    for (const grantee of ["'tmanage_app'@'%'", "'tmanage_worker'@'%'"]) {
      const intent = intents.get(grantee) as NonNullable<ReturnType<typeof intents.get>>;
      expect(allows(intent, 'tmanage.finance_daily_facts:DELETE')).toBe(true);
      expect(allows(intent, 'tmanage.finance_daily_facts:UPDATE')).toBe(false);
    }
  });
});

describe('INT-52-25 — the facts rebuild', () => {
  it('is idempotent and equals the live SUM', async () => {
    await entry(120, 1, 12_000, 6_000);
    await entry(60, 1, null, 3_000);
    await entry(30, 0, 12_000, 6_000);
    await expense(1_000, 1_500, 'approved');
    await expense(5_000, 0, 'submitted');

    const store = createFinanceFactsStore(workerDb);
    const org = world.northstar.organizationId;
    const at = new Date('2026-11-02T03:00:00Z');
    const first = await store.rebuild(org, '2026-08-05', '2026-11-02', at);
    const once = await factSums();
    const second = await store.rebuild(org, '2026-08-05', '2026-11-02', at);
    expect(second).toBe(first);
    expect(await factSums()).toEqual(once);
    // billed = 12000 × 120 / 60; cost = (6000×120 + 3000×60 + 6000×30) / 60; expense = 1000 + 15 %.
    expect(once).toMatchObject({
      billed: '24000',
      cost: '18000',
      expense: '1150',
      billable: '180',
      unpriced: '60',
    });
  });
});
