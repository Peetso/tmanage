import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createRetainerStore, createWorkerDatabase } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { FinanceRepository } from '../src/modules/finance/finance.repository.js';
import { RetainersRepository } from '../src/modules/finance/retainers.repository.js';
import { RetainersService } from '../src/modules/finance/retainers.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 52-06 (0299) at the engine. Registry: the three tables are registered and granted as the brief
 * says. 409: a project covered by a live retainer cannot be covered twice. INT-52-13: two racing
 * rolls of one due period close it once and open one next period. AUTH-52-07: another client of
 * the same studio gets a 404.
 */

let db: TestDatabase;
let world: SeedWorld;
let workerDb: WorkerDatabase;
let service: RetainersService;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

beforeAll(async () => {
  db = await startTestDatabase();
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 3, statementTimeoutMs: 15_000 });
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new RetainersService({
    database: tenant,
    repository: new RetainersRepository(),
    finance: new FinanceRepository(),
    audit: new AuditService(tenant, new AuditEventsRepository()),
  });
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await workerDb?.end();
  await db.stop();
});

function owner(): { context: TenantContext; principal: Principal } {
  const ns = world.northstar;
  return {
    context: createTenantContext({
      organizationId: ns.organizationId,
      userId: ns.owner.id,
      membershipId: ns.owner.membershipId,
      principalKind: 'internal',
      capabilities: capabilitiesFor('owner'),
      policyVersion: '2026-11-02',
      correlationId: uuidv7(),
    }),
    principal: {
      userId: ns.owner.id,
      organizationId: ns.organizationId,
      kind: 'internal',
      role: 'owner',
      membershipId: ns.owner.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    } as Principal,
  };
}

/** The first day of last month (UTC): its period is due, this month's is not. */
function lastMonthStart(): string {
  const at = new Date();
  at.setUTCDate(1);
  at.setUTCMonth(at.getUTCMonth() - 1);
  return at.toISOString().slice(0, 10);
}

async function create(startsOn = lastMonthStart()): Promise<string> {
  const { context, principal } = owner();
  const view = await service.create(context, principal, world.atlas.clientOrganizationId, {
    name: 'Social media',
    hoursPerPeriod: 40,
    rollover: 'cap',
    rolloverCapMinutes: 600,
    startsOn,
  });
  return view.id;
}

describe('0299 — registry', () => {
  it('registers the three tables and grants the worker the roll', () => {
    for (const table of ['retainers', 'retainer_projects', 'retainer_periods']) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
    }
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    expect(allows(worker, 'tmanage.retainer_periods:INSERT')).toBe(true);
    expect(allows(worker, 'tmanage.retainers:UPDATE')).toBe(false);
  });
});

describe('52-06 — one retainer per project', () => {
  it('refuses a second live retainer over the same project with 409', async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ status: 409 });
  });
});

describe('INT-52-13 — the period roll', () => {
  it('closes a due period once and opens one next period across two racing passes', async () => {
    const startsOn = lastMonthStart();
    await create(startsOn);
    const ns = world.northstar;
    await db.admin.query(
      `INSERT INTO work_item_time_logs
         (id, organization_id, work_item_id, project_id, logged_by, minutes, spent_on, created_at)
       VALUES (?, ?, ?, ?, ?, 300, ?, ?)`,
      [
        uuidv7(),
        ns.organizationId,
        ns.workItemId,
        ns.projectId,
        ns.owner.membershipId,
        startsOn,
        new Date(`${startsOn}T10:00:00Z`),
      ],
    );
    const store = createRetainerStore(workerDb);
    const [due] = await store.listDue(10);
    const results = await Promise.all([store.rollPeriod(due!), store.rollPeriod(due!)]);
    expect([...results].sort()).toEqual([false, true]);
    const [rows] = (await db.admin.query(
      `SELECT state, used_minutes_cache, rollover_in_minutes FROM retainer_periods
        WHERE organization_id = ? ORDER BY period_start`,
      [ns.organizationId],
    )) as unknown as [{ state: string; used_minutes_cache: number; rollover_in_minutes: number }[]];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'closed', used_minutes_cache: 300 });
    expect(rows[1]).toMatchObject({ state: 'open', rollover_in_minutes: 600 });
  });
});

describe('AUTH-52-07 — the portal projection across clients', () => {
  it('is a 404 for another client of the same studio', async () => {
    const id = await create();
    const meridian: Principal = {
      userId: world.meridian.reviewer.id,
      organizationId: world.northstar.organizationId,
      kind: 'client',
      role: 'client_reviewer',
      membershipId: world.meridian.reviewer.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: world.meridian.clientOrganizationId,
      projectIds: [world.meridian.projectId],
      hasOrgWideScope: false,
    };
    const context = createTenantContext({
      organizationId: world.northstar.organizationId,
      userId: meridian.userId,
      membershipId: meridian.membershipId,
      principalKind: 'client',
      capabilities: capabilitiesFor('client_reviewer'),
      policyVersion: '2026-11-02',
      correlationId: uuidv7(),
    });
    await expect(service.portalGet(context, meridian, id)).rejects.toMatchObject({ status: 404 });
  });
});
