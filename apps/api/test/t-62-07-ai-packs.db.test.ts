import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AiAllowanceService } from '../src/modules/billing/ai-allowance.service.js';
import { AiPacksPlatformService } from '../src/modules/billing/ai-packs-platform.service.js';
import { AiPacksService } from '../src/modules/billing/ai-packs.service.js';
import { AiBudgetRepository } from '../src/modules/copilot/ai-budget.repository.js';
import { AiBudgetService } from '../src/modules/copilot/ai-budget.service.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 62-07 (plan 62 §5, §7) — credit packs on MariaDB 11.8, through the real repositories and
 * services over a guarded TenantDatabase. FOR THE TEST PHASE (lane T did not run it, laptop rule):
 *
 * 1. Allowance first, then the oldest pack; an expired pack is never drawn; every move is a
 *    ledger row; the period's `pack_credits` equals the moves.
 * 2. 50 racing tasks against one pack never overdraw it (sum of draws = the pack, remaining 0).
 * 3. A closed month's unused pack credits return once, to the newest live pack.
 * 4. One open pack request: two racing requests give one row and one 409; off the test list the
 *    feature is absent (404); the twin tenant never sees northstar's request or packs.
 * 5. A platform grant against the request: one pack, 6 months, the request granted, one platform
 *    audit row in the same transaction.
 */

const TABLES = [
  'ai_credit_pack_moves',
  'ai_credit_pack_requests',
  'ai_credit_packs',
  'ai_usage_ledger',
  'ai_tasks',
  'ai_member_periods',
  'ai_workspace_periods',
  'ai_budget_pools',
  'ai_workspace_settings',
] as const;

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function ownerOf(organizationId: string, user: SeededUser): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 't-62-07',
    correlationId: uuidv7(),
  });
}

async function listed(organizationId: string): Promise<void> {
  const at = new Date('2026-11-01T00:00:00.000Z');
  await db.admin.execute(
    `insert into ai_workspace_settings (id, organization_id, test_list_at, pool_class, created_at, updated_at)
     values (?, ?, ?, 'customers', ?, ?)`,
    [uuidv7(), organizationId, at, at, at],
  );
}

async function pack(
  organizationId: string,
  credits: number,
  grantedAt: string,
  expiresAt: string,
): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into ai_credit_packs (id, organization_id, size_credits, remaining_credits, source,
       granted_at, expires_at, created_at) values (?, ?, ?, ?, 'grant', ?, ?, ?)`,
    [
      id,
      organizationId,
      credits,
      credits,
      new Date(grantedAt),
      new Date(expiresAt),
      new Date(grantedAt),
    ],
  );
  return id;
}

async function remaining(id: string): Promise<number> {
  const [row] = await rows('select remaining_credits from ai_credit_packs where id = ?', [id]);
  return Number(row?.['remaining_credits']);
}

function services(clock: { at: Date }) {
  const audit = new AuditService(database);
  const allowance = new AiAllowanceService({ database, now: () => clock.at });
  const packs = new AiPacksService({ database, allowance, audit, now: () => clock.at });
  const budget = new AiBudgetService({
    database,
    store: new AiBudgetRepository(),
    platformCapMicroUsd: 100_000_000,
    packs,
    now: () => clock.at,
  });
  return { packs, budget };
}

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 8,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
}, 180_000);

beforeEach(async () => {
  for (const table of TABLES) await db.admin.query(`delete from ${table}`);
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('allowance first, then the oldest live pack', () => {
  it('draws only what the allowance lacks, oldest first, never an expired pack', async () => {
    const org = world.northstar.organizationId;
    const ctx = ownerOf(org, world.northstar.owner);
    await listed(org);
    const expired = await pack(org, 1000, '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const older = await pack(org, 7, '2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z');
    const newer = await pack(org, 50, '2026-10-01T00:00:00Z', '2027-04-01T00:00:00Z');
    const clock = { at: new Date('2026-11-20T10:00:00.000Z') };
    const { budget } = services(clock);
    const allowance = { workspaceCredits: 5, memberCredits: 1000 };
    // low tier holds 5: the first from the allowance, the next three from packs (7 + 8 of 50).
    for (let i = 0; i < 4; i += 1) {
      const task = await budget.openTask(ctx, { tier: 'low', activity: 'tasks', allowance });
      expect(task.ok).toBe(true);
    }
    expect(await remaining(expired)).toBe(1000);
    expect(await remaining(older)).toBe(0);
    expect(await remaining(newer)).toBe(42);
    const [period] = await rows(
      'select pack_credits from ai_workspace_periods where organization_id = ? and period_start = ?',
      [org, '2026-11-01'],
    );
    const [moved] = await rows(
      `select sum(credits) as credits from ai_credit_pack_moves
        where organization_id = ? and period_start = ? and direction = 'draw'`,
      [org, '2026-11-01'],
    );
    expect(Number(period?.['pack_credits'])).toBe(15);
    expect(Number(moved?.['credits'])).toBe(15);
  });

  it('50 racing tasks on one pack never overdraw it', async () => {
    const org = world.northstar.organizationId;
    const ctx = ownerOf(org, world.northstar.owner);
    await listed(org);
    const only = await pack(org, 100, '2026-10-01T00:00:00Z', '2027-04-01T00:00:00Z');
    const clock = { at: new Date('2026-12-02T10:00:00.000Z') };
    const { budget } = services(clock);
    const allowance = { workspaceCredits: 0, memberCredits: 100_000 };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        budget.openTask(ctx, { tier: 'low', activity: 'tasks', allowance }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.reason))).toEqual(
      Array.from({ length: 30 }, () => 'workspace_credits_used'),
    );
    expect(await remaining(only)).toBe(0);
  });
});

describe('a closed month gives its unused pack credits back once', () => {
  it('returns the unused part to the pack on the next top-up, and only once', async () => {
    const org = world.northstar.organizationId;
    const ctx = ownerOf(org, world.northstar.owner);
    await listed(org);
    const p = await pack(org, 100, '2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z');
    // October: no allowance, 30 moved in from the pack, 10 spent, nothing held.
    const oct = new Date('2026-10-31T12:00:00.000Z');
    await db.admin.execute(
      `insert into ai_workspace_periods (id, organization_id, period_start, allowance_credits,
         pack_credits, settled_credits, reserved_credits, created_at, updated_at)
       values (?, ?, '2026-10-01', 0, 30, 10, 0, ?, ?)`,
      [uuidv7(), org, oct, oct],
    );
    await db.admin.execute(
      `insert into ai_credit_pack_moves (id, organization_id, pack_id, period_start, direction,
         credits, created_at) values (?, ?, ?, '2026-10-01', 'draw', 30, ?)`,
      [uuidv7(), org, p, oct],
    );
    await db.admin.execute('update ai_credit_packs set remaining_credits = 70 where id = ?', [p]);
    const clock = { at: new Date('2026-11-05T10:00:00.000Z') };
    const { budget } = services(clock);
    const allowance = { workspaceCredits: 0, memberCredits: 100_000 };
    // Two November tasks (5 each): the first returns October's 20 unused, both draw 5.
    for (let i = 0; i < 2; i += 1) {
      const task = await budget.openTask(ctx, { tier: 'low', activity: 'tasks', allowance });
      expect(task.ok).toBe(true);
    }
    expect(await remaining(p)).toBe(70 + 20 - 10);
    const returns = await rows(
      "select credits from ai_credit_pack_moves where organization_id = ? and direction = 'return'",
      [org],
    );
    expect(returns.map((r) => Number(r['credits']))).toEqual([20]);
    const [october] = await rows(
      "select pack_returned_at from ai_workspace_periods where organization_id = ? and period_start = '2026-10-01'",
      [org],
    );
    expect(october?.['pack_returned_at']).not.toBeNull();
  });
});

describe('the pack request', () => {
  it('two racing requests give one open row and one 409; twin never sees it; off-list is 404', async () => {
    const org = world.northstar.organizationId;
    const ctx = ownerOf(org, world.northstar.owner);
    await listed(org);
    const { packs } = services({ at: new Date('2026-11-20T10:00:00.000Z') });
    const outcomes = await Promise.allSettled([packs.requestPack(ctx), packs.requestPack(ctx)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const [count] = await rows(
      "select count(*) as n from ai_credit_pack_requests where organization_id = ? and status = 'open'",
      [org],
    );
    expect(Number(count?.['n'])).toBe(1);
    const twin = ownerOf(world.twin.organizationId, world.twin.owner);
    await expect(packs.credits(twin)).rejects.toMatchObject({ status: 404 });
    await expect(packs.requestPack(twin)).rejects.toMatchObject({ status: 404 });
  });

  it('a platform grant against it: one pack, 6 months, granted, one audit row', async () => {
    const org = world.northstar.organizationId;
    const ctx = ownerOf(org, world.northstar.owner);
    await listed(org);
    const clock = { at: new Date('2026-11-20T10:00:00.000Z') };
    const { packs } = services(clock);
    const request = await packs.requestPack(ctx);
    const platform = new AiPacksPlatformService({ database, now: () => clock.at });
    const actor = {
      account: { userId: world.northstar.owner.id, email: world.northstar.owner.email },
    } as unknown as PlatformAdminActor;
    const grant = await platform.grantPack(
      actor,
      org,
      { sizeCredits: 500, requestId: request.id, reason: 'pilot company test credits' },
      { correlationId: uuidv7(), ip: null, userAgent: null },
    );
    expect(grant.expiresAt).toBe('2027-05-20T10:00:00.000Z');
    const view = await packs.credits(ctx);
    expect(view).toMatchObject({
      packBalanceCredits: 500,
      openRequest: null,
      canRequestPack: true,
    });
    const audits = await rows(
      "select action from platform_admin_audit_events where action = 'platform.ai_pack_granted' and organization_id = ?",
      [org],
    );
    expect(audits).toHaveLength(1);
  });
});
