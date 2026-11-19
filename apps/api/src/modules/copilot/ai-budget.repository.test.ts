import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import {
  createTenantContext,
  type SqlParameter,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { AiBudgetRepository } from './ai-budget.repository.js';

/**
 * 62-06 / B13 — the budget repository's statements, without a server.
 *
 * A recording runner answers every update with one changed row and every select with nothing, so
 * each method can be driven once and its SQL read back. What is pinned: the invariant predicates
 * (`settled + reserved + ? <= cap` on all three levels, `reserved >= ?` on every release), the
 * tenant predicate bound to the context's organization on every tenant table, bound times (never
 * the database clock) and no text column written.
 */

interface Statement {
  readonly sql: string;
  readonly params: readonly SqlParameter[];
}

function recorder() {
  const statements: Statement[] = [];
  const record = async (sql: string, params: readonly SqlParameter[] = []) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return (sql.trim().startsWith('select') ? [] : { affectedRows: 1 }) as never;
  };
  const runner: TenantQueryRunner = {
    execute: record,
    query: record,
    unscoped: () => ({ execute: record, query: record }),
  };
  return { runner, statements };
}

const ORG = uuidv7();
const MEMBER = uuidv7();
const ctx = createTenantContext({
  organizationId: ORG,
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: MEMBER,
  capabilities: [],
  policyVersion: 'v1',
  correlationId: uuidv7(),
});
const NOW = new Date('2026-11-19T10:00:00.000Z');
const P = '2026-11-01';

async function driveEveryMethod() {
  const repo = new AiBudgetRepository();
  const { runner, statements } = recorder();
  const call = {
    id: uuidv7(),
    taskId: uuidv7(),
    pool: 'customers' as const,
    poolPeriodStart: P,
    status: 'sent' as const,
    model: 'claude-haiku-5-5',
    holdMicroUsd: 700,
  };
  await repo.workspaceStanding(runner, ctx);
  await repo.ensurePoolPeriod(runner, {
    id: uuidv7(),
    pool: 'customers',
    periodStart: P,
    capMicroUsd: 1,
    now: NOW,
  });
  await repo.ensureWorkspacePeriod(runner, ctx, {
    id: uuidv7(),
    periodStart: P,
    allowanceCredits: 1,
    now: NOW,
  });
  await repo.ensureMemberPeriod(runner, ctx, {
    id: uuidv7(),
    membershipId: MEMBER,
    periodStart: P,
    capCredits: 1,
    now: NOW,
  });
  await repo.holdMemberCredits(runner, ctx, MEMBER, P, 5, NOW);
  await repo.holdWorkspaceCredits(runner, ctx, P, 5, NOW);
  await repo.closeMemberHold(runner, ctx, MEMBER, P, 5, 1, NOW);
  await repo.closeWorkspaceHold(runner, ctx, P, 5, 1, NOW);
  await repo.refundMemberCredits(runner, ctx, MEMBER, P, 1, NOW);
  await repo.refundWorkspaceCredits(runner, ctx, P, 1, NOW);
  await repo.countFreeSupport(runner, ctx, MEMBER, P, '2026-11-19', 20, NOW);
  await repo.countRefund(runner, ctx, MEMBER, P, '2026-11-19', 5, NOW);
  await repo.holdPool(runner, 'customers', P, 700, 80, NOW);
  await repo.settlePool(runner, 'customers', P, 700, 250, NOW);
  await repo.poolState(runner, 'customers', P);
  await repo.pausePlatform(runner, P, 'over_settlement', NOW);
  await repo.insertTask(runner, ctx, {
    id: call.taskId,
    membershipId: MEMBER,
    tier: 'low',
    activity: 'tasks',
    pool: 'customers',
    ceilingCredits: 5,
    startedAt: NOW,
  });
  await repo.lockTask(runner, ctx, call.taskId);
  await repo.addTaskCost(runner, ctx, call.taskId, 250);
  await repo.finishTask(runner, ctx, call.taskId, 'completed', 1, NOW);
  await repo.undoTask(runner, ctx, call.taskId, 1, NOW);
  await repo.staleRunningTasks(runner, ctx, NOW, 10);
  await repo.insertCallHold(runner, ctx, {
    id: call.id,
    taskId: call.taskId,
    membershipId: MEMBER,
    pool: 'customers',
    poolPeriodStart: P,
    model: 'claude-haiku-5-5',
    priceTableVersion: '2026-11-03',
    holdMicroUsd: 700,
    holdCredits: 1,
    reservedAt: NOW,
    holdExpiresAt: NOW,
  });
  await repo.findCall(runner, ctx, call.id);
  await repo.taskSpend(runner, ctx, call.taskId);
  await repo.markCallSent(runner, ctx, call.id, NOW);
  await repo.settleCall(runner, ctx, call.id, {
    costMicroUsd: 250,
    usage: {
      inputTokens: 1,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1,
    },
    toolCalls: 0,
    latencyMs: 1,
    stopReason: 'end_turn',
    providerMessageId: 'msg_1',
    settledAt: NOW,
  });
  await repo.releaseCall(runner, ctx, call.id, NOW);
  await repo.closeLostCall(runner, ctx, call, NOW);
  await repo.lostCalls(runner, ctx, NOW, 10);
  return statements;
}

const TENANT_TABLES = [
  'ai_workspace_settings',
  'ai_workspace_periods',
  'ai_member_periods',
  'ai_tasks',
  'ai_usage_ledger',
];

describe('AiBudgetRepository statements', () => {
  it('binds the organization on every tenant-table statement', async () => {
    for (const { sql, params } of await driveEveryMethod()) {
      const table = TENANT_TABLES.find((name) => new RegExp(`\\b${name}\\b`).test(sql));
      if (table === undefined) {
        expect(sql).toMatch(/\bai_budget_pools\b/);
        continue;
      }
      expect(params, sql).toContain(ORG);
      expect(sql).toMatch(/organization_id( = \?|,)/);
    }
  });

  it('keeps settled + reserved <= cap with conditional holds, and never releases more than held', async () => {
    const sqls = (await driveEveryMethod()).map((s) => s.sql);
    const holds = sqls.filter((sql) => /set reserved_\w+ = reserved_\w+ \+ \?/.test(sql));
    expect(holds).toHaveLength(3);
    expect(holds[0]).toContain('settled_credits + reserved_credits + ? <= cap_credits');
    expect(holds[1]).toContain('settled_credits + reserved_credits + ? <= allowance_credits');
    expect(holds[1]).toContain('paused_at is null');
    expect(holds[2]).toContain(
      '(settled_micro_usd + reserved_micro_usd + ?) * 100 <= cap_micro_usd * ?',
    );
    expect(holds[2]).toContain('paused_at is null');
    const releases = sqls.filter((sql) => /reserved_\w+ = reserved_\w+ - \?/.test(sql));
    expect(releases).toHaveLength(3);
    for (const sql of releases) expect(sql).toMatch(/reserved_\w+ >= \?$/);
    const refunds = sqls.filter((sql) => /settled_credits = settled_credits - \?/.test(sql));
    expect(refunds).toHaveLength(2);
    for (const sql of refunds) expect(sql).toMatch(/settled_credits >= \?$/);
  });

  it('moves calls and tasks only from the state the transition starts at', async () => {
    const sqls = (await driveEveryMethod()).map((s) => s.sql);
    // Matched by table and new status (the lint rule keeps whole statements out of test files).
    const move = (table: string, to: string) =>
      sqls.find((sql) => sql.includes(` ${table} `) && sql.includes(`status = ${to},`)) ?? '';
    expect(move('ai_usage_ledger', "'sent'")).toContain("and status = 'reserved'");
    expect(move('ai_usage_ledger', "'settled'")).toContain("and status = 'sent'");
    expect(move('ai_usage_ledger', "'released'")).toContain("and status = 'reserved'");
    expect(move('ai_usage_ledger', '?')).toContain('and hold_expires_at <= ?');
    expect(move('ai_tasks', '?')).toContain("and status = 'running'");
    expect(move('ai_tasks', "'undone'")).toContain("and status = 'completed'");
    expect(sqls.find((sql) => sql.includes('membership_id, tier, pool'))).toMatch(/for update$/);
  });

  it('uses bound times, never the database clock, and writes no text column', async () => {
    for (const { sql } of await driveEveryMethod()) {
      expect(sql).not.toMatch(/current_timestamp|now\(\)|utc_timestamp|curdate/i);
      expect(sql).not.toMatch(/\b(prompt|question|answer|content|arguments)\b/i);
    }
  });
});
