import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import {
  createServiceContext,
  createTenantContext,
  withActorChannel,
  type TenantContext,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AiUsage } from './ai-cost.js';
import type {
  AiCallRecord,
  AiCallSettlement,
  AiPoolState,
  AiTaskRecord,
  AiTaskSpend,
  AiTaskStatus,
  IsoDate,
  NewAiCallHold,
  NewAiTask,
} from './ai-budget.repository.js';
import {
  AiBudgetService,
  worstCaseHoldMicroUsd,
  type AiBudgetResult,
  type AiBudgetStore,
} from './ai-budget.service.js';
import type { AiPool, AiSpendingPool, AiWorkspaceStanding } from './ai-tiers.js';

/**
 * 62-06 / B13 — the budget service on an in-memory store.
 *
 * `FakeStore` answers each repository method with the same predicate its SQL carries (the SQL
 * itself is pinned in `ai-budget.repository.test.ts`), and `FakeDatabase` rolls the whole store
 * back when a transaction throws, as InnoDB does. The real concurrency proof (200 parallel holds,
 * two processes, crash between send and settle) is the database suite's, in the test phase.
 */

interface Counter {
  cap: number;
  settled: number;
  reserved: number;
  paused: boolean;
}
interface MemberRow extends Counter {
  freeDay: IsoDate | null;
  freeCount: number;
  refundDay: IsoDate | null;
  refundCount: number;
}
/** The fake store's rows: the repository's records, which it moves in place like the SQL does. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };
interface TaskRow extends Writable<AiTaskRecord> {
  org: string;
  refunded: number;
}
interface CallRow extends Writable<AiCallRecord> {
  org: string;
  expiresAt: Date;
  cost: number | null;
  stopReason: string | null;
}
interface State {
  pools: Map<string, Counter>;
  workspaces: Map<string, Counter>;
  members: Map<string, MemberRow>;
  tasks: Map<string, TaskRow>;
  calls: Map<string, CallRow>;
}

const RUNNER = {} as TenantQueryRunner;

class FakeStore implements AiBudgetStore {
  state: State = {
    pools: new Map(),
    workspaces: new Map(),
    members: new Map(),
    tasks: new Map(),
    calls: new Map(),
  };
  readonly standings = new Map<string, AiWorkspaceStanding>();
  /** Every pool a statement touched, to prove pool separation. */
  readonly poolsTouched = new Set<AiPool>();

  private member(ctx: TenantContext, membershipId: string, period: IsoDate): MemberRow | undefined {
    return this.state.members.get(`${ctx.organizationId}|${membershipId}|${period}`);
  }
  private workspace(ctx: TenantContext, period: IsoDate): Counter | undefined {
    return this.state.workspaces.get(`${ctx.organizationId}|${period}`);
  }
  private pool(pool: AiPool, period: IsoDate): Counter | undefined {
    this.poolsTouched.add(pool);
    return this.state.pools.get(`${pool}|${period}`);
  }
  private task(ctx: TenantContext, id: string): TaskRow | undefined {
    const row = this.state.tasks.get(id);
    return row?.org === ctx.organizationId ? row : undefined;
  }
  private call(ctx: TenantContext, id: string): CallRow | undefined {
    const row = this.state.calls.get(id);
    return row?.org === ctx.organizationId ? row : undefined;
  }

  async workspaceStanding(_r: TenantQueryRunner, ctx: TenantContext): Promise<AiWorkspaceStanding> {
    return this.standings.get(ctx.organizationId) ?? { poolClass: 'customers', onTestList: false };
  }
  async ensurePoolPeriod(
    _r: TenantQueryRunner,
    input: { pool: AiPool; periodStart: IsoDate; capMicroUsd: number },
  ): Promise<void> {
    const key = `${input.pool}|${input.periodStart}`;
    this.poolsTouched.add(input.pool);
    if (!this.state.pools.has(key)) {
      this.state.pools.set(key, { cap: input.capMicroUsd, settled: 0, reserved: 0, paused: false });
    }
  }
  async ensureWorkspacePeriod(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    input: { periodStart: IsoDate; allowanceCredits: number },
  ): Promise<void> {
    const key = `${ctx.organizationId}|${input.periodStart}`;
    if (!this.state.workspaces.has(key)) {
      this.state.workspaces.set(key, {
        cap: input.allowanceCredits,
        settled: 0,
        reserved: 0,
        paused: false,
      });
    }
  }
  async ensureMemberPeriod(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    input: { membershipId: string; periodStart: IsoDate; capCredits: number },
  ): Promise<void> {
    const key = `${ctx.organizationId}|${input.membershipId}|${input.periodStart}`;
    if (!this.state.members.has(key)) {
      this.state.members.set(key, {
        cap: input.capCredits,
        settled: 0,
        reserved: 0,
        paused: false,
        freeDay: null,
        freeCount: 0,
        refundDay: null,
        refundCount: 0,
      });
    }
  }
  async holdMemberCredits(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    membershipId: string,
    period: IsoDate,
    credits: number,
  ): Promise<boolean> {
    const row = this.member(ctx, membershipId, period);
    if (!row || row.settled + row.reserved + credits > row.cap) return false;
    row.reserved += credits;
    return true;
  }
  async holdWorkspaceCredits(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    period: IsoDate,
    credits: number,
  ): Promise<boolean> {
    const row = this.workspace(ctx, period);
    if (!row || row.paused || row.settled + row.reserved + credits > row.cap) return false;
    row.reserved += credits;
    return true;
  }
  private close(row: Counter | undefined, held: number, charged: number): boolean {
    if (!row || row.reserved < held) return false;
    row.reserved -= held;
    row.settled += charged;
    return true;
  }
  async closeMemberHold(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    membershipId: string,
    period: IsoDate,
    held: number,
    charged: number,
  ): Promise<boolean> {
    return this.close(this.member(ctx, membershipId, period), held, charged);
  }
  async closeWorkspaceHold(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    period: IsoDate,
    held: number,
    charged: number,
  ): Promise<boolean> {
    return this.close(this.workspace(ctx, period), held, charged);
  }
  private refund(row: Counter | undefined, credits: number): boolean {
    if (!row || row.settled < credits) return false;
    row.settled -= credits;
    return true;
  }
  async refundMemberCredits(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    membershipId: string,
    period: IsoDate,
    credits: number,
  ): Promise<boolean> {
    return this.refund(this.member(ctx, membershipId, period), credits);
  }
  async refundWorkspaceCredits(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    period: IsoDate,
    credits: number,
  ): Promise<boolean> {
    return this.refund(this.workspace(ctx, period), credits);
  }
  async countFreeSupport(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    membershipId: string,
    period: IsoDate,
    day: IsoDate,
    limit: number,
  ): Promise<boolean> {
    const row = this.member(ctx, membershipId, period);
    if (!row || (row.freeDay === day && row.freeCount >= limit)) return false;
    row.freeCount = row.freeDay === day ? row.freeCount + 1 : 1;
    row.freeDay = day;
    return true;
  }
  async countRefund(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    membershipId: string,
    period: IsoDate,
    day: IsoDate,
    limit: number,
  ): Promise<boolean> {
    const row = this.member(ctx, membershipId, period);
    if (!row || (row.refundDay === day && row.refundCount >= limit)) return false;
    row.refundCount = row.refundDay === day ? row.refundCount + 1 : 1;
    row.refundDay = day;
    return true;
  }
  async holdPool(
    _r: TenantQueryRunner,
    pool: AiSpendingPool,
    period: IsoDate,
    hold: number,
    limitPercent: number,
  ): Promise<boolean> {
    const row = this.pool(pool, period);
    if (!row || row.paused || (row.settled + row.reserved + hold) * 100 > row.cap * limitPercent) {
      return false;
    }
    row.reserved += hold;
    return true;
  }
  async settlePool(
    _r: TenantQueryRunner,
    pool: AiSpendingPool,
    period: IsoDate,
    hold: number,
    cost: number,
  ): Promise<boolean> {
    return this.close(this.pool(pool, period), hold, cost);
  }
  async poolState(
    _r: TenantQueryRunner,
    pool: AiSpendingPool,
    period: IsoDate,
  ): Promise<AiPoolState | null> {
    const row = this.pool(pool, period);
    return row
      ? {
          capMicroUsd: row.cap,
          settledMicroUsd: row.settled,
          reservedMicroUsd: row.reserved,
          paused: row.paused,
        }
      : null;
  }
  async pausePlatform(_r: TenantQueryRunner, period: IsoDate): Promise<void> {
    for (const [key, row] of this.state.pools) if (key.endsWith(`|${period}`)) row.paused = true;
  }
  async insertTask(_r: TenantQueryRunner, ctx: TenantContext, task: NewAiTask): Promise<void> {
    this.state.tasks.set(task.id, {
      id: task.id,
      org: ctx.organizationId,
      membershipId: task.membershipId,
      tier: task.tier,
      pool: task.pool,
      status: 'running',
      ceilingCredits: task.ceilingCredits,
      chargedCredits: 0,
      costMicroUsd: 0,
      startedAt: task.startedAt,
      refunded: 0,
    });
  }
  async lockTask(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
  ): Promise<AiTaskRecord | null> {
    const row = this.task(ctx, id);
    return row ? { ...row } : null;
  }
  async addTaskCost(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
    cost: number,
  ): Promise<boolean> {
    const row = this.task(ctx, id);
    if (!row || row.status !== 'running') return false;
    row.costMicroUsd += cost;
    return true;
  }
  async finishTask(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
    status: Exclude<AiTaskStatus, 'running' | 'undone'>,
    charged: number,
  ): Promise<boolean> {
    const row = this.task(ctx, id);
    if (!row || row.status !== 'running') return false;
    row.status = status;
    row.chargedCredits = charged;
    return true;
  }
  async undoTask(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
    refunded: number,
  ): Promise<boolean> {
    const row = this.task(ctx, id);
    if (!row || row.status !== 'completed') return false;
    row.status = 'undone';
    row.refunded = refunded;
    return true;
  }
  async staleRunningTasks(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    before: Date,
  ): Promise<readonly string[]> {
    return [...this.state.tasks.values()]
      .filter(
        (t) => t.org === ctx.organizationId && t.status === 'running' && t.startedAt <= before,
      )
      .map((t) => t.id);
  }
  async insertCallHold(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    hold: NewAiCallHold,
  ): Promise<void> {
    this.state.calls.set(hold.id, {
      id: hold.id,
      org: ctx.organizationId,
      taskId: hold.taskId,
      pool: hold.pool,
      poolPeriodStart: hold.poolPeriodStart,
      status: 'reserved',
      model: hold.model,
      holdMicroUsd: hold.holdMicroUsd,
      expiresAt: hold.holdExpiresAt,
      cost: null,
      stopReason: null,
    });
  }
  async findCall(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
  ): Promise<AiCallRecord | null> {
    const row = this.call(ctx, id);
    return row ? { ...row } : null;
  }
  async taskSpend(_r: TenantQueryRunner, ctx: TenantContext, taskId: string): Promise<AiTaskSpend> {
    let settledMicroUsd = 0;
    let openHoldMicroUsd = 0;
    let openCalls = 0;
    for (const c of this.state.calls.values()) {
      if (c.org !== ctx.organizationId || c.taskId !== taskId) continue;
      if (c.status === 'settled') settledMicroUsd += c.cost ?? 0;
      if (c.status === 'reserved' || c.status === 'sent') {
        openHoldMicroUsd += c.holdMicroUsd;
        openCalls += 1;
      }
    }
    return { settledMicroUsd, openHoldMicroUsd, openCalls };
  }
  async markCallSent(_r: TenantQueryRunner, ctx: TenantContext, id: string): Promise<boolean> {
    const row = this.call(ctx, id);
    if (!row || row.status !== 'reserved') return false;
    row.status = 'sent';
    return true;
  }
  async settleCall(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    id: string,
    settlement: AiCallSettlement,
  ): Promise<boolean> {
    const row = this.call(ctx, id);
    if (!row || row.status !== 'sent') return false;
    row.status = 'settled';
    row.cost = settlement.costMicroUsd;
    return true;
  }
  async releaseCall(_r: TenantQueryRunner, ctx: TenantContext, id: string): Promise<boolean> {
    const row = this.call(ctx, id);
    if (!row || row.status !== 'reserved') return false;
    row.status = 'released';
    return true;
  }
  async closeLostCall(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    call: AiCallRecord,
    now: Date,
  ): Promise<boolean> {
    const row = this.call(ctx, call.id);
    if (!row || row.status !== call.status || row.expiresAt > now) return false;
    const sent = call.status === 'sent';
    row.status = sent ? 'settled' : 'expired';
    row.cost = sent ? row.holdMicroUsd : 0;
    row.stopReason = sent ? 'lost_result' : null;
    return true;
  }
  async lostCalls(
    _r: TenantQueryRunner,
    ctx: TenantContext,
    now: Date,
  ): Promise<readonly AiCallRecord[]> {
    return [...this.state.calls.values()]
      .filter(
        (c) =>
          c.org === ctx.organizationId &&
          (c.status === 'reserved' || c.status === 'sent') &&
          c.expiresAt <= now,
      )
      .map((c) => ({ ...c }));
  }
  async organizationsWithLostCalls(): Promise<readonly string[]> {
    return [];
  }
}

/** One transaction = all or nothing, as InnoDB: a throw restores the store as it was. */
function fakeDatabase(store: FakeStore) {
  return {
    async transaction<T>(
      _ctx: TenantContext,
      work: (tx: TenantQueryRunner) => Promise<T>,
    ): Promise<T> {
      const snapshot = structuredClone(store.state);
      try {
        return await work(RUNNER);
      } catch (error) {
        store.state = snapshot;
        throw error;
      }
    },
  };
}

function memberContext(organizationId: string, membershipId = uuidv7()): TenantContext {
  return createTenantContext({
    organizationId,
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId,
    capabilities: [],
    policyVersion: 'v1',
    correlationId: uuidv7(),
  });
}

const START = new Date('2026-11-19T10:00:00.000Z');
const PERIOD = '2026-11-01';
const ALLOWANCE = { workspaceCredits: 1000, memberCredits: 500 };
/** Haiku: 1000 prompt tokens at the 1 h write rate (200) + 1000 output (500) = 700 micro-USD. */
const SMALL_CALL = { promptTokens: 1000, maxTokens: 1000 };
const SMALL_USAGE: AiUsage = {
  inputTokens: 500,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 400,
};

function setup(options: { platformCapMicroUsd?: number } = {}) {
  const store = new FakeStore();
  let now = START;
  const clock = {
    set: (at: Date) => {
      now = at;
    },
  };
  const service = new AiBudgetService({
    database: fakeDatabase(store),
    store,
    platformCapMicroUsd: options.platformCapMicroUsd ?? 100_000_000,
    now: () => now,
  });
  const org = uuidv7();
  store.standings.set(org, { poolClass: 'customers', onTestList: true });
  const ctx = memberContext(org);
  return { store, service, clock, org, ctx };
}

function value<T>(result: AiBudgetResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

function reason<T>(result: AiBudgetResult<T>): string {
  return result.ok ? 'ok' : result.reason;
}

describe('openTask — who may spend, and from which pool', () => {
  it('holds the tier ceiling on the member and the workspace of a listed customer workspace', async () => {
    const { store, service, ctx, org } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    expect(task).toMatchObject({
      tier: 'low',
      model: 'claude-haiku-5-5',
      pool: 'customers',
      payer: 'workspace',
      ceilingCredits: 5,
    });
    expect(store.state.members.get(`${org}|${ctx.membershipId}|${PERIOD}`)?.reserved).toBe(5);
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)?.reserved).toBe(5);
  });

  it('refuses an MCP channel, a client, unnamed service work and an unlisted workspace', async () => {
    const { store, service, ctx, org } = setup();
    const input = { tier: 'low' as const, activity: 'tasks' as const, allowance: ALLOWANCE };
    expect(reason(await service.openTask(withActorChannel(ctx, 'ai_assistant'), input))).toBe(
      'caller_not_allowed',
    );
    const client = createTenantContext({ ...memberContext(org), principalKind: 'client' });
    expect(reason(await service.openTask(client, input))).toBe('caller_not_allowed');
    const worker = createServiceContext({
      organizationId: org,
      correlationId: uuidv7(),
      policyVersion: 'worker',
    });
    expect(reason(await service.openTask(worker, input))).toBe('caller_not_allowed');
    expect(reason(await service.openTask(ctx, { ...input, systemJob: 'benchmark' }))).toBe(
      'caller_not_allowed',
    );
    store.standings.set(org, { poolClass: 'customers', onTestList: false });
    expect(reason(await service.openTask(ctx, input))).toBe('not_on_test_list');
    expect(store.state.tasks.size).toBe(0);
  });

  it('keeps the pools apart: testing workspaces and the benchmark draw from testing, never reserve', async () => {
    const { store, service, ctx, org } = setup();
    store.standings.set(org, { poolClass: 'testing', onTestList: true });
    const own = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    expect(own.pool).toBe('testing');
    value(await service.reserveCall(ctx, { taskId: own.taskId, ...SMALL_CALL }));

    const bench = createServiceContext({
      organizationId: uuidv7(),
      correlationId: uuidv7(),
      policyVersion: 'bench',
    });
    const job = value(
      await service.openTask(bench, {
        tier: 'medium',
        activity: 'tasks',
        allowance: ALLOWANCE,
        systemJob: 'benchmark',
      }),
    );
    expect(job).toMatchObject({ pool: 'testing', payer: 'platform' });
    value(await service.reserveCall(bench, { taskId: job.taskId, ...SMALL_CALL }));
    expect(store.state.workspaces.size).toBe(1); // the benchmark debits no workspace
    expect([...store.poolsTouched]).toEqual(['testing']);
  });

  it('rolls back the member hold when the workspace allowance is used up', async () => {
    const { store, service, ctx, org } = setup();
    const tight = { workspaceCredits: 4, memberCredits: 500 };
    expect(
      reason(await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: tight })),
    ).toBe('workspace_credits_used');
    expect(store.state.members.size).toBe(0);
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)).toBeUndefined();
    const share = { workspaceCredits: 1000, memberCredits: 4 };
    expect(
      reason(await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: share })),
    ).toBe('member_credits_used');
  });

  it('counts free help answers: 20 a day per member, the 21st refused, the next day counts again', async () => {
    const { store, service, clock, ctx, org } = setup();
    const help = { tier: 'help' as const, activity: 'support' as const, allowance: ALLOWANCE };
    for (let i = 0; i < 20; i += 1) expect((await service.openTask(ctx, help)).ok).toBe(true);
    expect(reason(await service.openTask(ctx, help))).toBe('free_support_used');
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)).toBeUndefined(); // the platform pays
    clock.set(new Date('2026-11-20T08:00:00.000Z'));
    expect((await service.openTask(ctx, help)).ok).toBe(true);
  });
});

describe('reserveCall — worst-case holds within the tier ceiling and the pool cap', () => {
  it('holds the worst case computed on the server and pins the tier model', async () => {
    const { store, service, ctx } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const call = value(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }));
    expect(call).toMatchObject({ model: 'claude-haiku-5-5', holdMicroUsd: 700 });
    expect(call.holdExpiresAt.getTime()).toBe(START.getTime() + 15 * 60 * 1000);
    expect(store.state.pools.get(`customers|${PERIOD}`)).toMatchObject({
      cap: 60_000_000,
      reserved: 700,
    });
  });

  it('stops a looping task at its tier ceiling (5 credits = 5000 micro-USD for low)', async () => {
    const { service, ctx } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    for (let i = 0; i < 7; i += 1)
      value(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }));
    expect(reason(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }))).toBe(
      'tier_ceiling',
    );
  });

  it('never lets settled + reserved pass the pool cap, and says "platform paused" at the cap', async () => {
    const { store, service, ctx } = setup({ platformCapMicroUsd: 10_000 }); // customers: 6000
    const taskIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      taskIds.push(
        value(await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }))
          .taskId,
      );
    }
    const results = [];
    for (const taskId of taskIds) {
      results.push(await service.reserveCall(ctx, { taskId, ...SMALL_CALL }));
      const pool = store.state.pools.get(`customers|${PERIOD}`);
      expect((pool?.settled ?? 0) + (pool?.reserved ?? 0)).toBeLessThanOrEqual(6000);
    }
    expect(results.filter((r) => r.ok)).toHaveLength(8); // 8 × 700 = 5600
    expect(reason(results[8]!)).toBe('platform_paused');
  });

  it('switches Sonnet off past 80 % of the customer pool while Haiku still runs', async () => {
    const { service, ctx } = setup({ platformCapMicroUsd: 20_000 }); // customers: 12 000, 80 % = 9600
    const sonnetCall = { promptTokens: 100, maxTokens: 100 }; // 400 + 1000 = 1400
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const task = value(
        await service.openTask(ctx, {
          tier: 'medium_high',
          activity: 'file_analysis',
          allowance: { workspaceCredits: 5000, memberCredits: 5000 },
        }),
      );
      outcomes.push(reason(await service.reserveCall(ctx, { taskId: task.taskId, ...sonnetCall })));
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'sonnet_unavailable']);
    const haiku = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    expect((await service.reserveCall(ctx, { taskId: haiku.taskId, ...SMALL_CALL })).ok).toBe(true);
  });
});

describe('send, settle, release, finish — the two counters', () => {
  async function settledTask(outcome: 'completed' | 'failed') {
    const env = setup();
    const { service, ctx } = env;
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const call = value(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }));
    value(await service.markSent(ctx, call.callId));
    const settled = value(
      await service.settleCall(ctx, {
        callId: call.callId,
        usage: SMALL_USAGE,
        toolCalls: 1,
        latencyMs: 800,
        stopReason: 'end_turn',
        providerMessageId: 'msg_1',
      }),
    );
    const finished = value(await service.finishTask(ctx, task.taskId, outcome));
    return { ...env, task, call, settled, finished };
  }

  it('charges completed work its real cost in whole credits and releases the rest of every hold', async () => {
    const { store, org, ctx, settled, finished } = await settledTask('completed');
    expect(settled).toEqual({ costMicroUsd: 250, overSettled: false }); // 500 × 0.1 + 400 × 0.5
    expect(finished).toEqual({ chargedCredits: 1, costMicroUsd: 250 });
    expect(store.state.pools.get(`customers|${PERIOD}`)).toMatchObject({
      settled: 250,
      reserved: 0,
    });
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)).toMatchObject({
      settled: 1,
      reserved: 0,
    });
    expect(store.state.members.get(`${org}|${ctx.membershipId}|${PERIOD}`)).toMatchObject({
      settled: 1,
      reserved: 0,
    });
  });

  it('charges failed work 0 credits while the pool still records the real money', async () => {
    const { store, org, finished } = await settledTask('failed');
    expect(finished.chargedCredits).toBe(0);
    expect(store.state.pools.get(`customers|${PERIOD}`)?.settled).toBe(250);
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)).toMatchObject({
      settled: 0,
      reserved: 0,
    });
  });

  it('never charges above the tier ceiling', async () => {
    const { store, service, ctx, org } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    store.state.tasks.get(task.taskId)!.costMicroUsd = 4999; // as if several calls settled
    expect(value(await service.finishTask(ctx, task.taskId, 'completed')).chargedCredits).toBe(5);
    store.state.workspaces.get(`${org}|${PERIOD}`)!.settled = 0;
    const second = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    store.state.tasks.get(second.taskId)!.costMicroUsd = 9000;
    expect(value(await service.finishTask(ctx, second.taskId, 'completed')).chargedCredits).toBe(5);
  });

  it('releases a call that was never sent, and refuses to settle it', async () => {
    const { store, service, ctx } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const call = value(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }));
    const settle = {
      callId: call.callId,
      usage: SMALL_USAGE,
      toolCalls: 0,
      latencyMs: null,
      stopReason: null,
      providerMessageId: null,
    };
    expect(reason(await service.settleCall(ctx, settle))).toBe('call_not_sent');
    expect(reason(await service.finishTask(ctx, task.taskId, 'completed'))).toBe('calls_open');
    value(await service.releaseCall(ctx, call.callId));
    expect(store.state.pools.get(`customers|${PERIOD}`)).toMatchObject({ settled: 0, reserved: 0 });
    expect(reason(await service.releaseCall(ctx, call.callId))).toBe('call_not_reserved');
    expect(reason(await service.markSent(ctx, call.callId))).toBe('call_not_reserved');
  });

  it('records an over-settlement in full and pauses the platform', async () => {
    const { store, service, ctx } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const call = value(await service.reserveCall(ctx, { taskId: task.taskId, ...SMALL_CALL }));
    value(await service.markSent(ctx, call.callId));
    const usage = { ...SMALL_USAGE, inputTokens: 0, outputTokens: 2000 }; // 1000 > hold 700
    const settled = value(
      await service.settleCall(ctx, {
        callId: call.callId,
        usage,
        toolCalls: 0,
        latencyMs: 1,
        stopReason: 'max_tokens',
        providerMessageId: null,
      }),
    );
    expect(settled).toEqual({ costMicroUsd: 1000, overSettled: true });
    expect(store.state.pools.get(`customers|${PERIOD}`)).toMatchObject({
      settled: 1000,
      reserved: 0,
      paused: true,
    });
    const next = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    expect(reason(await service.reserveCall(ctx, { taskId: next.taskId, ...SMALL_CALL }))).toBe(
      'platform_paused',
    );
  });
});

describe('refundTask — undo gives the credits back, 5 a day per member', () => {
  it('refunds the charged credits, then stops refunding after the fifth of the day', async () => {
    const { store, service, ctx, org } = setup();
    const refunds = [];
    for (let i = 0; i < 6; i += 1) {
      const task = value(
        await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
      );
      store.state.tasks.get(task.taskId)!.costMicroUsd = 3000;
      value(await service.finishTask(ctx, task.taskId, 'completed'));
      refunds.push(value(await service.refundTask(ctx, task.taskId)));
      expect(reason(await service.refundTask(ctx, task.taskId))).toBe('task_not_completed');
    }
    expect(refunds.slice(0, 5)).toEqual(Array(5).fill({ refundedCredits: 3, limited: false }));
    expect(refunds[5]).toEqual({ refundedCredits: 0, limited: true });
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)?.settled).toBe(3); // only the sixth stays charged
    expect(store.state.pools.get(`customers|${PERIOD}`)).toBeUndefined(); // no call, no pool money moved
  });

  it('gives nothing back for a task charged in an earlier month', async () => {
    const { store, service, clock, ctx } = setup();
    const task = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    store.state.tasks.get(task.taskId)!.costMicroUsd = 3000;
    value(await service.finishTask(ctx, task.taskId, 'completed'));
    clock.set(new Date('2026-12-01T00:00:01.000Z'));
    expect(value(await service.refundTask(ctx, task.taskId))).toEqual({
      refundedCredits: 0,
      limited: false,
    });
  });
});

describe('expireLostHolds — crash paths', () => {
  it('releases a never-sent hold, settles a sent one in full and fails the abandoned task', async () => {
    const { store, service, clock, ctx, org } = setup();
    const a = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const lostReserved = value(await service.reserveCall(ctx, { taskId: a.taskId, ...SMALL_CALL }));
    const b = value(
      await service.openTask(ctx, { tier: 'low', activity: 'tasks', allowance: ALLOWANCE }),
    );
    const lostSent = value(await service.reserveCall(ctx, { taskId: b.taskId, ...SMALL_CALL }));
    value(await service.markSent(ctx, lostSent.callId));

    clock.set(new Date(START.getTime() + 14 * 60 * 1000)); // before expiry: nothing moves
    expect(await service.expireLostHolds(ctx)).toEqual({
      releasedCalls: 0,
      settledInFull: 0,
      failedTasks: 0,
    });

    clock.set(new Date(START.getTime() + 61 * 60 * 1000));
    expect(await service.expireLostHolds(ctx)).toEqual({
      releasedCalls: 1,
      settledInFull: 1,
      failedTasks: 2,
    });
    expect(store.state.calls.get(lostReserved.callId)).toMatchObject({
      status: 'expired',
      cost: 0,
    });
    expect(store.state.calls.get(lostSent.callId)).toMatchObject({
      status: 'settled',
      cost: 700,
      stopReason: 'lost_result',
    });
    expect(store.state.pools.get(`customers|${PERIOD}`)).toMatchObject({
      settled: 700,
      reserved: 0,
    });
    expect(store.state.tasks.get(b.taskId)).toMatchObject({
      status: 'failed',
      chargedCredits: 0,
      costMicroUsd: 700,
    });
    expect(store.state.workspaces.get(`${org}|${PERIOD}`)).toMatchObject({
      settled: 0,
      reserved: 0,
    });
    expect(await service.expireLostHolds(ctx)).toEqual({
      releasedCalls: 0,
      settledInFull: 0,
      failedTasks: 0,
    });
  });
});

describe('worstCaseHoldMicroUsd', () => {
  it('is never below the real cost of any split of the same prompt and output', () => {
    const hold = worstCaseHoldMicroUsd('claude-sonnet-5-5', 10_000, 2_000);
    expect(hold).toBe(10_000 * 4 + 2_000 * 10);
    expect(() => worstCaseHoldMicroUsd('claude-opus-5-5', 1, 1)).toThrow();
  });
});
