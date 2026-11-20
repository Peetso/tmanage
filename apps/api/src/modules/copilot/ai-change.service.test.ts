import { describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { createTenantContext, type TenantContext } from '../../common/database/tenant-context.js';
import { signReauthToken } from '../identity/reauth-token.js';
import { COMMAND_REGISTRY } from '../search/command-registry.js';
import type { AiCallResult, AiClient } from './ai-client.js';
import type { AiBudgetResult, OpenTaskInput } from './ai-budget.service.js';
import { AiChangeService, parseConfirmBody, type ChangeApprovals } from './ai-change.service.js';
import { parseChangeState, type AiChangeState } from './ai-change.repository.js';
import { META_TOOL_NAMES } from './ai-chat-tools.js';
import { AI_UNDO_WINDOW_MS } from './ai-undo.js';
import type { AiReplay, AiResponseBlock, AiStopReason } from './ai-response.js';
import { AI_TIER_SPECS } from './ai-tiers.js';
import {
  CopilotChatService,
  type ChatStanding,
  type ChatSurface,
  type ChatToolResult,
} from './copilot-chat.service.js';

/**
 * 62-11 part 2 (plan 62 §4.3, §7) — preview, confirm, undo end to end over a scripted model, an
 * in-memory workspace behind the member's surface and an in-memory `ai_tasks` change state. No
 * key, no network. Cases from the slice row: the card equals what runs; the confirm rules (same
 * member, once, 10 minutes, unaltered); undo restores and refunds; a changed record refuses the
 * undo; money stops at step-up and the typed amount; run at once only for an everyday change.
 */

const CARD_KEY = 'test-card-key';
const SESSION_SECRET = 'test-session-secret';
const SCOPE = { orgSlug: 'northstar', commands: COMMAND_REGISTRY };

function memberContext(base?: TenantContext, overrides: Record<string, unknown> = {}) {
  return createTenantContext({
    organizationId: base?.organizationId ?? uuidv7(),
    userId: base?.userId ?? uuidv7(),
    membershipId: base?.membershipId ?? uuidv7(),
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 'v1',
    correlationId: uuidv7(),
    ...overrides,
  });
}

const USAGE = {
  inputTokens: 100,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 20,
};

function reply(stopReason: AiStopReason, content: AiResponseBlock[]): AiCallResult {
  return {
    id: `msg_${uuidv7()}`,
    model: 'scripted',
    stopReason,
    content,
    replay: content as unknown as AiReplay,
    usage: USAGE,
    cost: { microUsd: 50, model: 'claude-haiku-5-5' } as never,
    latencyMs: 5,
  };
}
const route = (domain: string, tier: string) =>
  reply('tool_use', [{ type: 'tool_use', id: 'r1', name: 'route', input: { domain, tier } }]);
const text = (value: string) => reply('end_turn', [{ type: 'text', text: value }]);
const runAction = (id: string, actionId: string, args: unknown) =>
  reply('tool_use', [
    {
      type: 'tool_use',
      id,
      name: META_TOOL_NAMES.run,
      input: { action_id: actionId, args_json: JSON.stringify(args) },
    },
  ]);

type WorkItem = Record<string, unknown> & { id: string; updatedAt: string; version: number };

/** The member's workspace behind `liveMcpSurface`: work items and expenses, every call recorded. */
function workspace() {
  const items = new Map<string, WorkItem>();
  const calls: { opId: string; args: Record<string, unknown> }[] = [];
  let tick = 0;
  const stamp = () => `2026-11-21T10:00:${String((tick += 1)).padStart(2, '0')}Z`;
  items.set('wi_1', {
    id: 'wi_1',
    title: 'Homepage review',
    dueAt: '2026-11-20T09:00:00Z',
    version: 3,
    updatedAt: stamp(),
  });
  const ok = (data: unknown): ChatToolResult => ({ summary: 'ran', data });
  const fail = (data: string): ChatToolResult => ({ isError: true, data });
  const surface: ChatSurface = {
    async runTool(name, raw) {
      if (name === META_TOOL_NAMES.describe) return ok({ action_id: raw['action_id'] });
      if (name !== META_TOOL_NAMES.run) return fail('unknown tool');
      const opId = String(raw['action_id']);
      const args = (raw['args'] ?? {}) as Record<string, unknown>;
      calls.push({ opId, args });
      const id = String(args['workItemId'] ?? '');
      switch (opId) {
        case 'work_items.get':
          return items.has(id) ? ok({ ...items.get(id)! }) : fail('HTTP 404');
        case 'work_items.update': {
          const item = items.get(id);
          if (item === undefined) return fail('HTTP 404');
          if (args['version'] !== undefined && args['version'] !== item.version) {
            return fail('HTTP 409');
          }
          const { workItemId: _id, version: _v, ...fields } = args;
          Object.assign(item, fields, { version: item.version + 1, updatedAt: stamp() });
          return ok({ ...item });
        }
        case 'work_items.create': {
          const created: WorkItem = {
            id: `wi_${uuidv7()}`,
            ...args,
            version: 1,
            updatedAt: stamp(),
          };
          items.set(created.id, created);
          return ok({ ...created });
        }
        case 'work_items.delete':
          return items.delete(id) ? ok(null) : fail('HTTP 404');
        case 'finance.expenses.create':
          return ok({ id: 'exp_1', ...args, updatedAt: stamp() });
        default:
          return fail(`HTTP 404 ${opId}`);
      }
    },
  };
  return { items, calls, surface, touch: (id: string) => (items.get(id)!.updatedAt = stamp()) };
}

function setup(script: AiCallResult[], standing: Partial<ChatStanding> = {}) {
  let now = new Date('2026-11-21T10:00:00Z');
  const clock = () => now;
  const ws = workspace();
  const tasks = new Map<
    string,
    { status: string; membershipId: string; change: AiChangeState | null }
  >();
  const refunds: string[] = [];
  const audits: { action: string; metadata: unknown }[] = [];
  const ok = <T>(value: T): AiBudgetResult<T> => ({ ok: true, value });
  const client: AiClient = {
    async call() {
      const next = script.shift();
      if (next === undefined) throw new Error('the script ran out');
      return next;
    },
  };
  const budget = {
    async openTask(ctx: TenantContext, input: OpenTaskInput) {
      const taskId = uuidv7();
      tasks.set(taskId, { status: 'running', membershipId: ctx.membershipId, change: null });
      const spec = AI_TIER_SPECS[input.tier];
      return ok({
        taskId,
        tier: input.tier,
        model: spec.model,
        pool: 'customers' as const,
        payer: spec.payer,
        ceilingCredits: spec.ceilingCredits,
      });
    },
    async reserveCall(_c: TenantContext, input: { taskId: string }) {
      return ok({
        callId: uuidv7(),
        model: AI_TIER_SPECS.medium.model,
        holdMicroUsd: 1,
        holdExpiresAt: now,
        taskId: input.taskId,
      });
    },
    async markSent() {
      return ok(null);
    },
    async settleCall() {
      return ok({ costMicroUsd: 50, overSettled: false });
    },
    async releaseCall() {
      return ok(null);
    },
    async finishTask(
      _c: TenantContext,
      taskId: string,
      outcome: string,
      _receipt?: unknown,
      undo?: Readonly<Record<string, unknown>>,
    ) {
      const task = tasks.get(taskId)!;
      task.status = outcome;
      task.change = undo === undefined ? null : parseChangeState(JSON.stringify(undo));
      return ok({ chargedCredits: 3, costMicroUsd: 50 });
    },
    async refundTask(_c: TenantContext, taskId: string) {
      refunds.push(taskId);
      tasks.get(taskId)!.status = 'undone';
      return ok({ refundedCredits: 3, limited: false });
    },
  };
  /** `ai_tasks.undo_json` with the guarded moves of `AiChangeRepository`. */
  const repository = {
    async read(_r: unknown, ctx: TenantContext, taskId: string) {
      const task = tasks.get(taskId);
      if (task === undefined || task.membershipId !== ctx.membershipId) return null;
      return { status: task.status, change: task.change };
    },
    async claimCard(
      _r: unknown,
      ctx: TenantContext,
      taskId: string,
      cardId: string,
      next: AiChangeState,
    ) {
      const task = tasks.get(taskId);
      if (
        task === undefined ||
        task.membershipId !== ctx.membershipId ||
        task.status !== 'completed' ||
        task.change?.state !== 'card' ||
        task.change.card !== cardId
      ) {
        return false;
      }
      task.change = next;
      return true;
    },
    async move(_r: unknown, ctx: TenantContext, taskId: string, from: string, next: AiChangeState) {
      const task = tasks.get(taskId);
      if (
        task === undefined ||
        task.membershipId !== ctx.membershipId ||
        task.change?.state !== from
      ) {
        return false;
      }
      task.change = next;
      return true;
    },
  };
  const database = {
    read: (_c: TenantContext, work: (r: unknown) => unknown) => work({}),
    transaction: (_c: TenantContext, work: (r: unknown) => unknown) => work({}),
  };
  const approved: string[] = [];
  const approvals: ChangeApprovals = {
    async approve(_c, _slug, id) {
      approved.push(id);
    },
    async outcome() {
      return { status: 'approved', resultStatus: 204, result: null };
    },
  };
  const standingOf = async (): Promise<ChatStanding> => ({
    onTestList: true,
    copilotFlag: true,
    writeScope: 'read_write',
    runAtOnce: false,
    poolClass: 'customers',
    ...standing,
  });
  const chat = new CopilotChatService({
    standing: standingOf,
    allowance: async () => ({ workspaceCredits: 1000, memberCredits: 1000 }),
    budget: budget as never,
    clientFor: () => client,
    surface: () => ws.surface,
    countTokens: async () => 10,
    cardKey: CARD_KEY,
    freezeApproval: async () => 'pending_1',
    now: clock,
  });
  const changes = new AiChangeService({
    database: database as never,
    standing: standingOf,
    surface: () => ws.surface,
    budget: budget as never,
    audit: {
      async record(_r: unknown, _c: TenantContext, input: { action: string; metadata?: unknown }) {
        audits.push({ action: input.action, metadata: input.metadata });
        return {} as never;
      },
    } as never,
    approvals,
    cardKey: CARD_KEY,
    sessionSecret: SESSION_SECRET,
    repository: repository as never,
    now: clock,
  });
  const ctx = memberContext();
  return {
    ctx,
    ws,
    tasks,
    refunds,
    audits,
    approved,
    turn: (message: string, context = ctx) =>
      chat.chat(context, SCOPE, { message, confirmed: null }),
    confirm: (
      card: string,
      options: { amounts?: Record<number, number>; reauth?: boolean; context?: TenantContext } = {},
    ) => {
      const context = options.context ?? ctx;
      const sessionId = 'sess_1';
      const reauthToken = options.reauth
        ? signReauthToken(
            { userId: context.userId, sessionId, expiresAt: new Date(now.getTime() + 300_000) },
            SESSION_SECRET,
          )
        : undefined;
      return changes.confirm(
        context,
        'northstar',
        parseConfirmBody({ card, amounts: options.amounts ?? {} }),
        { reauthToken, sessionId },
      );
    },
    undo: (taskId: string, context = ctx) => changes.undo(context, 'northstar', taskId),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

async function status(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.auditCode ?? error.code}`;
    throw error;
  }
}

const moveDue = (dueAt: string) =>
  runAction('t1', 'work_items.update', { workItemId: 'wi_1', dueAt, version: 3 });

describe('the card equals what runs', () => {
  it('a proposed change runs nothing; the card is server-built with before and after', async () => {
    const env = setup([
      route('tasks', 'medium'),
      moveDue('2026-11-23T09:00:00Z'),
      text('Proposed.'),
    ]);
    const view = await env.turn('move the homepage review to Monday');
    expect(view.state).toBe('preview');
    expect(view.toolCalls).toEqual([{ opId: 'work_items.update', outcome: 'proposed' }]);
    expect(env.ws.calls.map((c) => c.opId)).toEqual(['work_items.get']);
    expect(view.card!.items).toEqual([
      expect.objectContaining({
        opId: 'work_items.update',
        title: 'Update work item',
        subject: 'Homepage review',
        changes: [
          { field: 'dueAt', before: '2026-11-20T09:00:00Z', after: '2026-11-23T09:00:00Z' },
        ],
        cannotBeUndone: false,
        stepUp: false,
      }),
    ]);
    expect(env.tasks.get(view.card!.taskId)!.change).toMatchObject({ state: 'card', entries: [] });
  });

  it('the confirm runs exactly the frozen arguments, once; then Done + Undo', async () => {
    const env = setup([
      route('tasks', 'medium'),
      moveDue('2026-11-23T09:00:00Z'),
      text('Proposed.'),
    ]);
    const view = await env.turn('move it');
    const confirmed = await env.confirm(view.card!.token);
    expect(confirmed.items).toEqual([{ index: 0, opId: 'work_items.update', outcome: 'done' }]);
    expect(confirmed.undoUntil).not.toBeNull();
    const writes = env.ws.calls.filter((c) => c.opId === 'work_items.update');
    expect(writes).toEqual([
      {
        opId: 'work_items.update',
        args: { workItemId: 'wi_1', dueAt: '2026-11-23T09:00:00Z', version: 3 },
      },
    ]);
    expect(env.ws.items.get('wi_1')!['dueAt']).toBe('2026-11-23T09:00:00Z');
    expect(env.audits).toEqual([
      {
        action: 'ai_change.confirmed',
        metadata: { client_id: 'tmanage-ai', ops: ['work_items.update'], outcomes: ['done'] },
      },
    ]);
    // A second confirm of the same card runs nothing.
    expect(await status(env.confirm(view.card!.token))).toBe('409 ai_card_used');
    expect(env.ws.calls.filter((c) => c.opId === 'work_items.update')).toHaveLength(1);
  });
});

describe('confirm rules', () => {
  it('an altered card, another member or another workspace: 404, nothing runs', async () => {
    const env = setup([
      route('tasks', 'medium'),
      moveDue('2026-11-23T09:00:00Z'),
      text('Proposed.'),
    ]);
    const view = await env.turn('move it');
    const token = view.card!.token;
    const [body, mac] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    payload.items[0].args.dueAt = '2027-01-01T09:00:00Z';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    expect(await status(env.confirm(forged))).toBe('404 ai_card_invalid');
    expect(await status(env.confirm(token, { context: memberContext() }))).toBe(
      '404 ai_card_invalid',
    );
    expect(
      await status(
        env.confirm(token, { context: memberContext(env.ctx, { membershipId: uuidv7() }) }),
      ),
    ).toBe('404 ai_card_invalid');
    expect(env.ws.calls.filter((c) => c.opId === 'work_items.update')).toEqual([]);
  });

  it('after 10 minutes the card has expired', async () => {
    const env = setup([
      route('tasks', 'medium'),
      moveDue('2026-11-23T09:00:00Z'),
      text('Proposed.'),
    ]);
    const view = await env.turn('move it');
    env.advance(10 * 60 * 1000 + 1);
    expect(await status(env.confirm(view.card!.token))).toBe('409 ai_card_expired');
  });

  it('read-only owner setting: the model is told, no card, nothing runs', async () => {
    const env = setup(
      [route('tasks', 'medium'), moveDue('2026-11-23T09:00:00Z'), text('I cannot.')],
      {
        writeScope: 'read',
      },
    );
    const view = await env.turn('move it');
    expect(view.state).toBe('answer');
    expect(view.toolCalls).toEqual([{ opId: 'work_items.update', outcome: 'refused' }]);
    expect(env.ws.calls).toEqual([]);
  });

  it('money: step-up and the typed amount, before anything runs', async () => {
    const expense = {
      spentOn: '2026-11-01',
      category: 'Software',
      amountMinor: 4900,
      currency: 'USD',
    };
    const env = setup([
      route('billing', 'medium'),
      runAction('t1', 'finance.expenses.create', expense),
      text('Proposed.'),
    ]);
    const view = await env.turn('log the 49 dollar software expense');
    expect(view.card!.items[0]).toMatchObject({
      sensitivity: 'money',
      stepUp: true,
      typedAmount: true,
      amount: 4900,
      cannotBeUndone: true,
    });
    expect(await status(env.confirm(view.card!.token, { amounts: { 0: 4900 } }))).toBe(
      '403 ai_card_step_up',
    );
    expect(await status(env.confirm(view.card!.token, { amounts: { 0: 490 }, reauth: true }))).toBe(
      '400 ai_card_amount_mismatch',
    );
    expect(env.ws.calls.filter((c) => c.opId === 'finance.expenses.create')).toEqual([]);
    const done = await env.confirm(view.card!.token, { amounts: { 0: 4900 }, reauth: true });
    expect(done).toMatchObject({ cannotBeUndone: true, undoUntil: null });
  });

  it('a confirm-class change is frozen for approval and approved by the confirm', async () => {
    const env = setup([
      route('tasks', 'medium'),
      runAction('t1', 'work_items.delete', { workItemId: 'wi_1' }),
      text('Proposed.'),
    ]);
    const view = await env.turn('delete the homepage review');
    expect(view.card!.items[0]).toMatchObject({
      opId: 'work_items.delete',
      sensitivity: 'destructive',
      approvalId: 'pending_1',
      cannotBeUndone: true,
    });
    expect(env.ws.items.has('wi_1')).toBe(true);
    const done = await env.confirm(view.card!.token);
    expect(env.approved).toEqual(['pending_1']);
    expect(done.items[0]!.outcome).toBe('done');
  });
});

describe('undo', () => {
  async function confirmedMove() {
    const env = setup([
      route('tasks', 'medium'),
      moveDue('2026-11-23T09:00:00Z'),
      text('Proposed.'),
    ]);
    const view = await env.turn('move it');
    await env.confirm(view.card!.token);
    return { env, taskId: view.card!.taskId };
  }

  it('restores the previous values and refunds the task', async () => {
    const { env, taskId } = await confirmedMove();
    const undone = await env.undo(taskId);
    expect(undone).toEqual({ taskId, state: 'undone', refundedCredits: 3 });
    expect(env.ws.items.get('wi_1')!['dueAt']).toBe('2026-11-20T09:00:00Z');
    expect(env.refunds).toEqual([taskId]);
    expect(env.audits.map((a) => a.action)).toEqual(['ai_change.confirmed', 'ai_change.undone']);
    expect(await status(env.undo(taskId))).toBe('409 ai_undo_not_available');
  });

  it('refuses when the record changed since, and runs nothing', async () => {
    const { env, taskId } = await confirmedMove();
    env.ws.touch('wi_1');
    const before = env.ws.calls.length;
    expect(await status(env.undo(taskId))).toBe('409 ai_undo_record_changed');
    expect(env.ws.calls.slice(before).map((c) => c.opId)).toEqual(['work_items.get']);
    expect(env.refunds).toEqual([]);
  });

  it('past 15 minutes, or by another member: refused', async () => {
    const { env, taskId } = await confirmedMove();
    expect(await status(env.undo(taskId, memberContext(env.ctx, { membershipId: uuidv7() })))).toBe(
      '404 ai_undo_task_not_visible',
    );
    env.advance(AI_UNDO_WINDOW_MS + 1);
    expect(await status(env.undo(taskId))).toBe('409 ai_undo_expired');
  });

  it('run at once: an everyday change with an undo runs now and can be undone; a create too', async () => {
    const env = setup(
      [
        route('tasks', 'medium'),
        moveDue('2026-11-23T09:00:00Z'),
        runAction('t2', 'work_items.create', { title: 'Draft the brief' }),
        text('Done.'),
      ],
      { runAtOnce: true },
    );
    const view = await env.turn('move it and add a brief task');
    expect(view.state).toBe('answer');
    expect(view.toolCalls.map((t) => t.outcome)).toEqual(['ok', 'ok']);
    expect(view.undo).toMatchObject({ cannotBeUndone: false });
    expect(env.ws.items.size).toBe(2);
    const undone = await env.undo(view.undo!.taskId);
    expect(undone.state).toBe('undone');
    expect(env.ws.items.size).toBe(1);
    expect(env.ws.items.get('wi_1')!['dueAt']).toBe('2026-11-20T09:00:00Z');
  });

  it('run at once never skips the card for a destructive or money change', async () => {
    const env = setup(
      [
        route('tasks', 'medium'),
        runAction('t1', 'work_items.delete', { workItemId: 'wi_1' }),
        text('Proposed.'),
      ],
      { runAtOnce: true },
    );
    const view = await env.turn('delete it');
    expect(view.state).toBe('preview');
    expect(env.ws.items.has('wi_1')).toBe(true);
  });
});
