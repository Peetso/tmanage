import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import {
  TenantDatabase,
  createServiceContext,
  createTenantContext,
} from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { AiBudgetRepository } from '../src/modules/copilot/ai-budget.repository.js';
import {
  AiBudgetService,
  worstCaseHoldMicroUsd,
  type AiBudgetResult,
  type AiCreditAllowance,
} from '../src/modules/copilot/ai-budget.service.js';
import { AI_CALL_HOLD_TTL_MS, AI_TASK_TTL_MS } from '../src/modules/copilot/ai-tiers.js';
import type { AiSpendingPool, AiTier } from '../src/modules/copilot/ai-tiers.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * T1 2026-11-19 lane C — the AI budget (plan 62, B08 tables 0381–0383, B13 service) on MariaDB
 * 11.8, through the real repository and service over guarded TenantDatabases:
 *
 * 1. Racing holds never pass a cap: 200 parallel `openTask` on one member's share and on one
 *    workspace's allowance, 200 parallel `reserveCall` on the platform pool — each over pools with
 *    several connections, the workspace and pool races from two separate pools ("processes").
 * 2. A crash between send and settle: the sweep settles a sent call in full (`lost_result`),
 *    releases a never-sent one, fails a task left running past 60 minutes.
 * 3. Pool separation: the benchmark draws testing, a customer workspace customers; reserve and
 *    packs are never drawn; a paused pool does not stop the other.
 * 4. A refusal rolls back every hold the transaction already took.
 * 5. Tenant isolation: northstar's ledger and periods are neither readable nor movable from twin.
 *
 * Every test starts from empty budget tables (the sweep and the pools see a whole organization's
 * or the whole platform's rows, so one test's holds must never reach the next) and runs in its own
 * month, so a failure's leftovers are never mistaken for a later test's.
 */

const BUDGET_TABLES = [
  'ai_usage_ledger',
  'ai_tasks',
  'ai_member_periods',
  'ai_workspace_periods',
  'ai_budget_pools',
  'ai_workspace_settings',
] as const;

let db: TestDatabase;
let world: SeedWorld;
/** Two independent connection pools: the API process and a second one racing it. */
let processA: TenantDatabase;
let processB: TenantDatabase;
const extraPools: Pool[] = [];

const store = new AiBudgetRepository();
const HAIKU = 'claude-haiku-5-5';
/** The prompt and `max_tokens` of every call here; its hold is computed, never hard-coded. */
const PROMPT_TOKENS = 1_000;
const MAX_TOKENS = 1_000;
const HOLD = worstCaseHoldMicroUsd(HAIKU, PROMPT_TOKENS, MAX_TOKENS);
const CALL = { promptTokens: PROMPT_TOKENS, maxTokens: MAX_TOKENS } as const;
const RACERS = 200;
const PLENTY: AiCreditAllowance = { workspaceCredits: 1_000_000, memberCredits: 100_000 };

// ── Fixtures and readers ──────────────────────────────────────────────────────

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function separatePool(): TenantDatabase {
  const pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 8,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  extraPools.push(pool);
  return new TenantDatabase(pool, { guardMode: 'enforce' });
}

function memberOf(organizationId: string, user: SeededUser): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 't1-1119-ai-budget',
    correlationId: uuidv7(),
  });
}

function serviceOf(organizationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId: uuidv7(),
    policyVersion: 'ai-benchmark',
  });
}

/** A movable clock shared by the services of one test. */
interface Clock {
  at: Date;
}

function budgetOver(database: TenantDatabase, clock: Clock, platformCapMicroUsd = 100_000_000) {
  return new AiBudgetService({ database, store, platformCapMicroUsd, now: () => clock.at });
}

function later(clock: Clock, ms: number): void {
  clock.at = new Date(clock.at.getTime() + ms);
}

/** Put a workspace on the AI test list with a pool class (the platform admin's setting). */
async function onTestList(organizationId: string, poolClass: AiSpendingPool): Promise<void> {
  const at = new Date('2026-11-01T00:00:00.000Z');
  await db.admin.execute(
    `insert into ai_workspace_settings
       (id, organization_id, test_list_at, pool_class, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on duplicate key update test_list_at = values(test_list_at), pool_class = values(pool_class)`,
    [uuidv7(), organizationId, at, poolClass, at, at],
  );
}

interface CounterRow {
  readonly cap: number;
  readonly settled: number;
  readonly reserved: number;
}

function counter(row: RowDataPacket | undefined): CounterRow {
  if (row === undefined) throw new Error('no counter row');
  return {
    cap: Number(row['cap']),
    settled: Number(row['settled']),
    reserved: Number(row['reserved']),
  };
}

async function memberCounter(org: string, user: SeededUser, period: string): Promise<CounterRow> {
  const [row] = await rows(
    `select cap_credits as cap, settled_credits as settled, reserved_credits as reserved
       from ai_member_periods where organization_id = ? and membership_id = ? and period_start = ?`,
    [org, user.membershipId, period],
  );
  return counter(row);
}

async function workspaceCounter(org: string, period: string): Promise<CounterRow> {
  const [row] = await rows(
    `select allowance_credits as cap, settled_credits as settled, reserved_credits as reserved
       from ai_workspace_periods where organization_id = ? and period_start = ?`,
    [org, period],
  );
  return counter(row);
}

async function poolCounter(pool: AiSpendingPool, period: string): Promise<CounterRow> {
  const [row] = await rows(
    `select cap_micro_usd as cap, settled_micro_usd as settled, reserved_micro_usd as reserved
       from ai_budget_pools where pool = ? and period_start = ?`,
    [pool, period],
  );
  return counter(row);
}

async function call(callId: string): Promise<RowDataPacket> {
  const [row] = await rows(
    `select status, pool, hold_micro_usd, cost_micro_usd, stop_reason
       from ai_usage_ledger where id = ?`,
    [callId],
  );
  if (row === undefined) throw new Error('no ledger row');
  return row;
}

async function task(taskId: string): Promise<RowDataPacket> {
  const [row] = await rows(
    'select status, pool, charged_credits, cost_micro_usd, finished_at from ai_tasks where id = ?',
    [taskId],
  );
  if (row === undefined) throw new Error('no task row');
  return row;
}

/** Pause or resume one platform pool for a month (what a platform admin or the 100 % stop does). */
async function setPoolPaused(pool: AiSpendingPool, period: string, paused: boolean): Promise<void> {
  await db.admin.execute(
    'update ai_budget_pools set paused_at = ? where pool = ? and period_start = ?',
    [paused ? new Date('2026-11-19T00:00:00.000Z') : null, pool, period],
  );
}

/** Unwrap a result the test expects to be granted. */
function granted<T>(result: AiBudgetResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
}

function refusal<T>(result: AiBudgetResult<T>): string | null {
  return result.ok ? null : result.reason;
}

/** Tally a race: grants, refusals by reason, and anything that threw (must be nothing). */
function tally<T>(settled: PromiseSettledResult<AiBudgetResult<T>>[]) {
  const errors = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []));
  const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const refusals: Record<string, number> = {};
  for (const r of results) if (!r.ok) refusals[r.reason] = (refusals[r.reason] ?? 0) + 1;
  return {
    errors: errors.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
    granted: results.filter((r) => r.ok).length,
    refusals,
  };
}

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  processA = separatePool();
  processB = separatePool();
}, 180_000);

beforeEach(async () => {
  for (const table of BUDGET_TABLES) await db.admin.query(`delete from ${table}`);
});

afterAll(async () => {
  for (const pool of extraPools) await pool.end();
  await db?.stop();
});

// ── 1. Racing holds never pass a cap ──────────────────────────────────────────

describe('racing holds never pass a cap', () => {
  it('200 parallel task holds on one member share grant exactly floor(cap / ceiling)', async () => {
    const org = world.northstar.organizationId;
    const owner = world.northstar.owner;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-01-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);
    const lowCeiling = 5;
    const allowance = { workspaceCredits: 1_000_000, memberCredits: lowCeiling * 37 + 3 };

    const outcome = tally(
      await Promise.allSettled(
        Array.from({ length: RACERS }, () =>
          budget.openTask(memberOf(org, owner), { tier: 'low', activity: 'tasks', allowance }),
        ),
      ),
    );

    expect(outcome.errors).toEqual([]);
    const member = await memberCounter(org, owner, '2027-01-01');
    expect(outcome.granted).toBe(Math.floor(member.cap / lowCeiling));
    expect(outcome.granted).toBe(37);
    expect(outcome.refusals).toEqual({ member_credits_used: RACERS - 37 });
    expect(member.settled + member.reserved).toBeLessThanOrEqual(member.cap);
    expect(member.reserved).toBe(37 * lowCeiling);
    const workspace = await workspaceCounter(org, '2027-01-01');
    expect(workspace.reserved).toBe(37 * lowCeiling);
    const [tasks] = await rows(
      `select count(*) as n from ai_tasks
        where organization_id = ? and membership_id = ? and started_at = ? and status = 'running'`,
      [org, owner.membershipId, clock.at],
    );
    expect(Number(tasks?.['n'])).toBe(37);
  }, 120_000);

  it('200 holds from two processes that all fit are all granted, none lost to an engine race', async () => {
    const org = world.northstar.organizationId;
    const owner = world.northstar.owner;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-01-20T09:00:00.000Z') };
    const budgets = [budgetOver(processA, clock), budgetOver(processB, clock)];
    const lowCeiling = 5;

    // Every racer moves the same member, workspace and period rows: each commit changes the row
    // the next one waits on, which is where a snapshot-bound transaction would be refused.
    const outcome = tally(
      await Promise.allSettled(
        Array.from({ length: RACERS }, (_, i) =>
          (budgets[i % 2] as AiBudgetService).openTask(memberOf(org, owner), {
            tier: 'low',
            activity: 'tasks',
            allowance: PLENTY,
          }),
        ),
      ),
    );

    expect(outcome.errors).toEqual([]);
    expect(outcome.granted).toBe(RACERS);
    expect((await memberCounter(org, owner, '2027-01-01')).reserved).toBe(RACERS * lowCeiling);
    expect((await workspaceCounter(org, '2027-01-01')).reserved).toBe(RACERS * lowCeiling);
  }, 120_000);

  it('200 holds from two processes on one workspace allowance grant exactly floor(allowance / ceiling)', async () => {
    const org = world.northstar.organizationId;
    const { owner, manager, designer } = world.northstar;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-02-10T09:00:00.000Z') };
    const budgets = [budgetOver(processA, clock), budgetOver(processB, clock)];
    const members = [owner, manager, designer];
    const lowCeiling = 5;
    const allowance = { workspaceCredits: lowCeiling * 41 + 2, memberCredits: 100_000 };

    const outcome = tally(
      await Promise.allSettled(
        Array.from({ length: RACERS }, (_, i) =>
          (budgets[i % 2] as AiBudgetService).openTask(
            memberOf(org, members[i % 3] as SeededUser),
            { tier: 'low', activity: 'clients', allowance },
          ),
        ),
      ),
    );

    expect(outcome.errors).toEqual([]);
    const workspace = await workspaceCounter(org, '2027-02-01');
    expect(outcome.granted).toBe(Math.floor(workspace.cap / lowCeiling));
    expect(outcome.granted).toBe(41);
    expect(outcome.refusals).toEqual({ workspace_credits_used: RACERS - 41 });
    expect(workspace.settled + workspace.reserved).toBeLessThanOrEqual(workspace.cap);
    expect(workspace.reserved).toBe(41 * lowCeiling);
    for (const member of members) {
      const row = await memberCounter(org, member, '2027-02-01');
      expect(row.settled + row.reserved).toBeLessThanOrEqual(row.cap);
    }
  }, 120_000);

  it('200 call holds from two processes and two workspaces on the platform pool grant exactly floor(cap / hold)', async () => {
    const north = world.northstar.organizationId;
    const twin = world.twin.organizationId;
    await onTestList(north, 'customers');
    await onTestList(twin, 'customers');
    const clock = { at: new Date('2027-03-10T09:00:00.000Z') };
    // A platform ceiling whose customer share (60 %) holds 57 calls and a remainder.
    const platformCap = Math.ceil(((57 * HOLD + Math.floor(HOLD / 2)) * 100) / 60);
    const [budgetA, budgetB] = [
      budgetOver(processA, clock, platformCap),
      budgetOver(processB, clock, platformCap),
    ] as const;

    const open = async (budget: AiBudgetService, context: TenantContext) =>
      granted(
        await budget.openTask(context, { tier: 'medium', activity: 'tasks', allowance: PLENTY }),
      ).taskId;
    const northTasks: string[] = [];
    const twinTasks: string[] = [];
    for (let i = 0; i < RACERS / 2; i += 1) {
      northTasks.push(await open(budgetA, memberOf(north, world.northstar.owner)));
      twinTasks.push(await open(budgetB, memberOf(twin, world.twin.owner)));
    }

    const outcome = tally(
      await Promise.allSettled([
        ...northTasks.map((taskId) =>
          budgetA.reserveCall(memberOf(north, world.northstar.owner), { taskId, ...CALL }),
        ),
        ...twinTasks.map((taskId) =>
          budgetB.reserveCall(memberOf(twin, world.twin.owner), { taskId, ...CALL }),
        ),
      ]),
    );

    expect(outcome.errors).toEqual([]);
    const pool = await poolCounter('customers', '2027-03-01');
    expect(pool.cap).toBe(Math.floor((platformCap * 60) / 100));
    expect(outcome.granted).toBe(Math.floor(pool.cap / HOLD));
    expect(outcome.granted).toBe(57);
    expect(outcome.refusals).toEqual({ platform_paused: RACERS - 57 });
    expect(pool.settled + pool.reserved).toBeLessThanOrEqual(pool.cap);
    expect(pool.reserved).toBe(57 * HOLD);
    const [ledger] = await rows(
      `select count(*) as n, coalesce(sum(hold_micro_usd), 0) as held from ai_usage_ledger
        where pool = 'customers' and pool_period_start = '2027-03-01' and status = 'reserved'`,
    );
    expect(Number(ledger?.['n'])).toBe(57);
    expect(Number(ledger?.['held'])).toBe(pool.reserved);
  }, 180_000);
});

// ── 2. A crash between send and settle ────────────────────────────────────────

describe('the hold-expiry sweep after a crash', () => {
  it('settles a sent call in full, expires a never-sent one, and leaves counters consistent', async () => {
    const org = world.northstar.organizationId;
    const owner = world.northstar.owner;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-04-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);
    const member = memberOf(org, owner);
    const sweeper = serviceOf(org);

    const { taskId } = granted(
      await budget.openTask(member, { tier: 'medium', activity: 'tasks', allowance: PLENTY }),
    );
    const sent = granted(await budget.reserveCall(member, { taskId, ...CALL }));
    granted(await budget.markSent(member, sent.callId));
    const unsent = granted(await budget.reserveCall(member, { taskId, ...CALL }));
    // The process dies here: no settle, no release.

    later(clock, AI_CALL_HOLD_TTL_MS - 60_000);
    expect(await budget.expireLostHolds(sweeper)).toEqual({
      releasedCalls: 0,
      settledInFull: 0,
      failedTasks: 0,
    });
    expect((await call(sent.callId))['status']).toBe('sent');
    expect((await poolCounter('customers', '2027-04-01')).reserved).toBe(2 * HOLD);

    later(clock, 60_000);
    expect(await budget.expireLostHolds(sweeper)).toEqual({
      releasedCalls: 1,
      settledInFull: 1,
      failedTasks: 0,
    });
    const lost = await call(sent.callId);
    expect(lost['status']).toBe('settled');
    expect(Number(lost['cost_micro_usd'])).toBe(HOLD);
    expect(lost['stop_reason']).toBe('lost_result');
    const never = await call(unsent.callId);
    expect(never['status']).toBe('expired');
    expect(Number(never['cost_micro_usd'])).toBe(0);
    expect(await poolCounter('customers', '2027-04-01')).toMatchObject({
      settled: HOLD,
      reserved: 0,
    });
    expect(Number((await task(taskId))['cost_micro_usd'])).toBe(HOLD);

    // The task can now close, charged the lost call's full hold in whole credits.
    expect(granted(await budget.finishTask(member, taskId, 'completed'))).toEqual({
      chargedCredits: Math.ceil(HOLD / 1_000),
      costMicroUsd: HOLD,
    });
    expect(await memberCounter(org, owner, '2027-04-01')).toMatchObject({
      settled: Math.ceil(HOLD / 1_000),
      reserved: 0,
    });
    expect(await workspaceCounter(org, '2027-04-01')).toMatchObject({
      settled: Math.ceil(HOLD / 1_000),
      reserved: 0,
    });
  }, 60_000);

  it('fails a task running past 60 minutes, releases its credit hold, and spares a younger task', async () => {
    const org = world.northstar.organizationId;
    const owner = world.northstar.owner;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-05-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);
    const member = memberOf(org, owner);
    const mediumCeiling = 30;

    const stale = granted(
      await budget.openTask(member, { tier: 'medium', activity: 'tasks', allowance: PLENTY }),
    );
    const unsent = granted(await budget.reserveCall(member, { taskId: stale.taskId, ...CALL }));
    later(clock, 30 * 60_000);
    const young = granted(
      await budget.openTask(member, { tier: 'medium', activity: 'tasks', allowance: PLENTY }),
    );

    later(clock, AI_TASK_TTL_MS - 30 * 60_000 + 1);
    expect(await budget.expireLostHolds(serviceOf(org))).toEqual({
      releasedCalls: 1,
      settledInFull: 0,
      failedTasks: 1,
    });

    expect((await call(unsent.callId))['status']).toBe('expired');
    const failed = await task(stale.taskId);
    expect(failed['status']).toBe('failed');
    expect(Number(failed['charged_credits'])).toBe(0);
    expect(failed['finished_at']).toBeInstanceOf(Date);
    expect((await task(young.taskId))['status']).toBe('running');
    // Only the younger task's ceiling is still held; nothing was charged.
    expect(await memberCounter(org, owner, '2027-05-01')).toMatchObject({
      settled: 0,
      reserved: mediumCeiling,
    });
    expect(await workspaceCounter(org, '2027-05-01')).toMatchObject({
      settled: 0,
      reserved: mediumCeiling,
    });
    expect(await poolCounter('customers', '2027-05-01')).toMatchObject({ settled: 0, reserved: 0 });
  }, 60_000);
});

// ── 3. Pool separation ────────────────────────────────────────────────────────

describe('pool separation', () => {
  it('the benchmark draws only testing, a customer workspace only customers; reserve and packs never', async () => {
    const north = world.northstar.organizationId;
    const bright = world.brightops.organizationId;
    await onTestList(north, 'customers');
    const clock = { at: new Date('2027-06-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);

    // BrightOps is not on the test list: its members are refused, the benchmark is not.
    const brightMember = memberOf(bright, world.brightops.owner);
    expect(
      refusal(
        await budget.openTask(brightMember, { tier: 'low', activity: 'tasks', allowance: PLENTY }),
      ),
    ).toBe('not_on_test_list');
    const bench = granted(
      await budget.openTask(serviceOf(bright), {
        tier: 'medium',
        activity: 'support',
        allowance: PLENTY,
        systemJob: 'benchmark',
      }),
    );
    expect(bench).toMatchObject({ pool: 'testing', payer: 'platform' });
    const benchCall = granted(
      await budget.reserveCall(serviceOf(bright), { taskId: bench.taskId, ...CALL }),
    );

    const northMember = memberOf(north, world.northstar.owner);
    const customer = granted(
      await budget.openTask(northMember, { tier: 'low', activity: 'tasks', allowance: PLENTY }),
    );
    expect(customer).toMatchObject({ pool: 'customers', payer: 'workspace' });
    const customerCall = granted(
      await budget.reserveCall(northMember, { taskId: customer.taskId, ...CALL }),
    );

    expect((await call(benchCall.callId))['pool']).toBe('testing');
    expect((await call(customerCall.callId))['pool']).toBe('customers');
    expect((await poolCounter('testing', '2027-06-01')).reserved).toBe(HOLD);
    expect((await poolCounter('customers', '2027-06-01')).reserved).toBe(HOLD);
    // The benchmark debits no workspace: BrightOps has no credit counters at all.
    const brightCounters = await rows(
      `select 'w' from ai_workspace_periods where organization_id = ?
       union all select 'm' from ai_member_periods where organization_id = ?`,
      [bright, bright],
    );
    expect(brightCounters).toEqual([]);
    const drawn = await rows("select pool from ai_budget_pools where pool in ('reserve', 'packs')");
    expect(drawn).toEqual([]);
  }, 60_000);

  it('a paused pool refuses its own callers and never stops the other pool', async () => {
    const north = world.northstar.organizationId;
    const twin = world.twin.organizationId;
    await onTestList(north, 'customers');
    await onTestList(twin, 'testing');
    const clock = { at: new Date('2027-07-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);
    const northMember = memberOf(north, world.northstar.owner);
    const twinMember = memberOf(twin, world.twin.owner);
    const open = async (context: TenantContext, tier: AiTier = 'medium') =>
      granted(await budget.openTask(context, { tier, activity: 'tasks', allowance: PLENTY }));
    const northTask = await open(northMember);
    const twinTask = await open(twinMember);
    expect(northTask.pool).toBe('customers');
    expect(twinTask.pool).toBe('testing');
    const reserveNorth = () =>
      budget.reserveCall(northMember, { taskId: northTask.taskId, ...CALL });
    const reserveTwin = () => budget.reserveCall(twinMember, { taskId: twinTask.taskId, ...CALL });
    granted(await reserveNorth());
    granted(await reserveTwin());

    await setPoolPaused('testing', '2027-07-01', true);
    expect(refusal(await reserveTwin())).toBe('platform_paused');
    expect(refusal(await reserveNorth())).toBeNull();

    await setPoolPaused('testing', '2027-07-01', false);
    await setPoolPaused('customers', '2027-07-01', true);
    expect(refusal(await reserveNorth())).toBe('platform_paused');
    expect(refusal(await reserveTwin())).toBeNull();

    expect((await poolCounter('customers', '2027-07-01')).reserved).toBe(2 * HOLD);
    expect((await poolCounter('testing', '2027-07-01')).reserved).toBe(2 * HOLD);
  }, 60_000);
});

// ── 4. A refusal rolls back every hold taken ──────────────────────────────────

describe('refusals', () => {
  it('a workspace refusal after the member hold rolls the member hold back', async () => {
    const org = world.northstar.organizationId;
    const owner = world.northstar.owner;
    await onTestList(org, 'customers');
    const clock = { at: new Date('2027-08-10T09:00:00.000Z') };
    const budget = budgetOver(processA, clock);
    const member = memberOf(org, owner);
    const lowCeiling = 5;
    const input = { tier: 'low', activity: 'tasks', allowance: PLENTY } as const;

    granted(await budget.openTask(member, input));
    await db.admin.execute(
      'update ai_workspace_periods set paused_at = ? where organization_id = ? and period_start = ?',
      [clock.at, org, '2027-08-01'],
    );

    // The member hold is taken first and succeeds; the paused workspace then refuses.
    expect(refusal(await budget.openTask(member, input))).toBe('workspace_credits_used');
    expect(await memberCounter(org, owner, '2027-08-01')).toMatchObject({
      settled: 0,
      reserved: lowCeiling,
    });
    expect(await workspaceCounter(org, '2027-08-01')).toMatchObject({
      settled: 0,
      reserved: lowCeiling,
    });
    const [tasks] = await rows(
      'select count(*) as n from ai_tasks where organization_id = ? and started_at = ?',
      [org, clock.at],
    );
    expect(Number(tasks?.['n'])).toBe(1);
  }, 60_000);
});

// ── 5. Tenant isolation ───────────────────────────────────────────────────────

describe('tenant isolation', () => {
  /** Everything northstar holds in the budget tables, in a stable order. */
  async function northstarBudget(org: string): Promise<unknown> {
    const tables = ['ai_tasks', 'ai_usage_ledger', 'ai_member_periods', 'ai_workspace_periods'];
    const out: Record<string, RowDataPacket[]> = {};
    for (const table of tables) {
      out[table] = await rows(`select * from ${table} where organization_id = ? order by id`, [
        org,
      ]);
    }
    return out;
  }

  it('twin can neither read nor move northstar’s tasks, calls or periods', async () => {
    const north = world.northstar.organizationId;
    const twin = world.twin.organizationId;
    await onTestList(north, 'customers');
    await onTestList(twin, 'customers');
    const clock = { at: new Date('2027-09-10T09:00:00.000Z') };
    const northMember = memberOf(north, world.northstar.owner);
    const twinMember = memberOf(twin, world.twin.owner);

    const setup = budgetOver(processA, clock);
    const { taskId } = granted(
      await setup.openTask(northMember, { tier: 'medium', activity: 'tasks', allowance: PLENTY }),
    );
    const reserved = granted(await setup.reserveCall(northMember, { taskId, ...CALL }));
    const sent = granted(await setup.reserveCall(northMember, { taskId, ...CALL }));
    granted(await setup.markSent(northMember, sent.callId));
    const before = await northstarBudget(north);

    // Proven with the guard only observing, then enforcing: the statements' own
    // organization predicate is what keeps twin out, not the guard alone.
    const guardEvents: TenantGuardEvent[] = [];
    const databases = [
      new TenantDatabase(db.runtime, {
        guardMode: 'observe',
        onGuardEvent: (event) => guardEvents.push(event),
      }),
      processA,
    ];
    later(clock, AI_CALL_HOLD_TTL_MS);
    for (const database of databases) {
      const budget = budgetOver(database, clock);
      const usage = {
        inputTokens: 10,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 10,
      };
      expect(refusal(await budget.reserveCall(twinMember, { taskId, ...CALL }))).toBe(
        'task_not_found',
      );
      expect(refusal(await budget.markSent(twinMember, reserved.callId))).toBe('call_not_reserved');
      expect(
        refusal(
          await budget.settleCall(twinMember, {
            callId: sent.callId,
            usage,
            toolCalls: 0,
            latencyMs: 1,
            stopReason: 'end_turn',
            providerMessageId: null,
          }),
        ),
      ).toBe('call_not_found');
      expect(refusal(await budget.releaseCall(twinMember, reserved.callId))).toBe('call_not_found');
      expect(refusal(await budget.finishTask(twinMember, taskId, 'completed'))).toBe(
        'task_not_found',
      );
      expect(refusal(await budget.refundTask(twinMember, taskId))).toBe('task_not_found');
      expect(await budget.expireLostHolds(serviceOf(twin))).toEqual({
        releasedCalls: 0,
        settledInFull: 0,
        failedTasks: 0,
      });

      const seen = await database.transaction(twinMember, async (tx) => ({
        task: await store.lockTask(tx, twinMember, taskId),
        call: await store.findCall(tx, twinMember, sent.callId),
        spend: await store.taskSpend(tx, twinMember, taskId),
        lost: await store.lostCalls(tx, twinMember, clock.at, 10),
      }));
      expect(seen).toEqual({
        task: null,
        call: null,
        spend: { settledMicroUsd: 0, openHoldMicroUsd: 0, openCalls: 0 },
        lost: [],
      });

      // Twin's own spend lands on twin's own rows.
      granted(
        await budget.openTask(twinMember, { tier: 'low', activity: 'tasks', allowance: PLENTY }),
      );
    }

    expect(guardEvents).toEqual([]);
    expect(await northstarBudget(north)).toEqual(before);
    expect(await workspaceCounter(twin, '2027-09-01')).toMatchObject({ reserved: 2 * 5 });
  }, 60_000);
});
