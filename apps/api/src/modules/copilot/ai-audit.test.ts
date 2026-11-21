import { describe, expect, it } from 'vitest';
import { isSafeAuditMetadata, uuidv7 } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { DatabaseAiAudit, toolCallResult, type AiTurnAudit } from './ai-audit.js';

/** 62-14 — one row per tool call and one per turn, in one transaction, never any text. */

const ctx = createTenantContext({
  organizationId: uuidv7(),
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'v1',
  correlationId: uuidv7(),
});

const TURN: AiTurnAudit = {
  taskId: uuidv7(),
  model: 'claude-haiku-5-5',
  tier: 'low',
  domain: 'tasks',
  outcome: 'completed',
  stop: null,
  modelCalls: 2,
  inputTokens: 900,
  outputTokens: 120,
  chargedCredits: 1,
  tainted: false,
  withheldFigures: 0,
  toolCalls: [
    {
      tool: 'tmanage_run_action',
      opId: 'work_items.list',
      outcome: 'ok',
      argsSha256: 'a'.repeat(64),
      latencyMs: 12,
    },
    {
      tool: 'work_items_update',
      opId: 'work_items.update',
      outcome: 'refused',
      argsSha256: 'b'.repeat(64),
      latencyMs: 3,
    },
  ],
};

function fakes(fail = false) {
  const rows: {
    action: string;
    result: string;
    objectId: string | null;
    metadata: unknown;
    channel: unknown;
  }[] = [];
  let transactions = 0;
  const database = {
    async transaction(_c: unknown, work: (tx: unknown) => Promise<unknown>) {
      transactions += 1;
      if (fail) throw new Error('db down');
      return work({});
    },
  } as unknown as TenantDatabase;
  const events = {
    async append(
      _tx: unknown,
      context: { actorChannel?: unknown },
      input: { action: string; result: string; objectId: string | null; metadata: unknown },
    ) {
      rows.push({ ...input, channel: context.actorChannel });
    },
  } as unknown as AuditEventsRepository;
  return { audit: new DatabaseAiAudit(database, events), rows, transactions: () => transactions };
}

describe('AI audit rows (62-14)', () => {
  it('writes one row per tool call and one turn row, in one transaction, as the AI channel', async () => {
    const { audit, rows, transactions } = fakes();
    await audit.turn(ctx, TURN);
    expect(transactions()).toBe(1);
    expect(rows.map((r) => r.action)).toEqual([
      'mcp.tool_called',
      'mcp.tool_called',
      'ai.turn_completed',
    ]);
    expect(rows.map((r) => r.result)).toEqual(['allowed', 'denied', 'allowed']);
    expect(rows.at(-1)?.objectId).toBe(TURN.taskId);
    expect(rows.every((r) => r.channel === 'ai_assistant')).toBe(true);
    for (const row of rows) expect(isSafeAuditMetadata(row.metadata)).toBe(true);
    expect(rows.at(-1)?.metadata).toMatchObject({
      client_id: 'tmanage-ai',
      input_size: 900,
      tool_calls: 2,
    });
  });

  it('never throws: a lost row is logged, the answer stands', async () => {
    const { audit } = fakes(true);
    await expect(audit.turn(ctx, TURN)).resolves.toBeUndefined();
  });

  it('maps outcomes to results', () => {
    expect(['ok', 'proposed', 'refused', 'error'].map((o) => toolCallResult(o as never))).toEqual([
      'allowed',
      'allowed',
      'denied',
      'error',
    ]);
  });
});
