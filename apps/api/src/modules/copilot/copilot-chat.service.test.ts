import { describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { createTenantContext, type TenantContext } from '../../common/database/tenant-context.js';
import { COMMAND_REGISTRY } from '../search/command-registry.js';
import type { AiCallResult, AiClient, AiRequest } from './ai-client.js';
import { AiClientError } from './ai-client.js';
import type { AiBudgetRefusal, AiBudgetResult, OpenTaskInput } from './ai-budget.service.js';
import { CHAT_TOOLS, META_TOOL_NAMES, isAiSelfOp, planToolCall } from './ai-chat-tools.js';
import type { AiReplay, AiResponseBlock, AiStopReason } from './ai-response.js';
import { parseRoute, routerRequest } from './ai-router.js';
import { AI_TIER_SPECS, type AiTier } from './ai-tiers.js';
import {
  CopilotChatService,
  TOOL_CALLS_PER_TURN,
  chatScopesFor,
  idempotencyKeyOf,
  parseChatBody,
  plainCommand,
  type ChatStanding,
  type ChatSurfaceInput,
  type ChatTurnInput,
} from './copilot-chat.service.js';

/**
 * 62-09 (plan 62 §4.1, §7) — the orchestrator against a scripted model, an in-memory budget and a
 * recording tool surface. No key, no network: every model reply below is written by the test.
 * Cases from the slice row: a read answer, a refused op, the loop stop, the tier ceiling, no silent
 * upgrade, scopes never `manage`/`billing`; plus the gates, the free pre-pass, the estimate,
 * `stop_reason` before tools, the idempotency key and the receipt.
 */

const SCOPE = { orgSlug: 'northstar', commands: COMMAND_REGISTRY };

function memberContext(overrides: Partial<Parameters<typeof createTenantContext>[0]> = {}) {
  return createTenantContext({
    organizationId: uuidv7(),
    userId: uuidv7(),
    membershipId: uuidv7(),
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
const text = (value: string, stop: AiStopReason = 'end_turn') =>
  reply(stop, [{ type: 'text', text: value }]);
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  reply('tool_use', [{ type: 'tool_use', id, name, input }]);
const runAction = (id: string, actionId: string, args: unknown = {}) =>
  toolUse(id, META_TOOL_NAMES.run, { action_id: actionId, args_json: JSON.stringify(args) });

function setup(
  script: Array<AiCallResult | Error>,
  options: {
    standing?: Partial<ChatStanding>;
    refuseReserveAt?: { call: number; reason: AiBudgetRefusal };
    refuseOpen?: AiBudgetRefusal;
  } = {},
) {
  const requests: AiRequest[] = [];
  const client: AiClient = {
    async call(request) {
      requests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error('the script ran out');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const opened: OpenTaskInput[] = [];
  const finished: {
    taskId: string;
    outcome: string;
    receipt?: Readonly<Record<string, unknown>>;
  }[] = [];
  const settled: { callId: string; outputTokens: number; cacheWrite1hTokens: number }[] = [];
  const released: string[] = [];
  let reserves = 0;
  const tasks = new Map<string, AiTier>();
  const ok = <T>(value: T): AiBudgetResult<T> => ({ ok: true, value });
  const budget = {
    async openTask(_c: TenantContext, input: OpenTaskInput) {
      if (options.refuseOpen !== undefined)
        return { ok: false as const, reason: options.refuseOpen };
      opened.push(input);
      const taskId = uuidv7();
      tasks.set(taskId, input.tier);
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
      reserves += 1;
      if (options.refuseReserveAt?.call === reserves) {
        return { ok: false as const, reason: options.refuseReserveAt.reason };
      }
      const tier = tasks.get(input.taskId) ?? 'low';
      return ok({
        callId: uuidv7(),
        model: AI_TIER_SPECS[tier].model,
        holdMicroUsd: 1000,
        holdExpiresAt: new Date(),
      });
    },
    async markSent() {
      return ok(null);
    },
    async settleCall(
      _c: TenantContext,
      input: { callId: string; usage: { outputTokens: number; cacheWrite1hTokens: number } },
    ) {
      settled.push({ callId: input.callId, ...input.usage });
      return ok({ costMicroUsd: 50, overSettled: false });
    },
    async releaseCall(_c: TenantContext, callId: string) {
      released.push(callId);
      return ok(null);
    },
    async finishTask(
      _c: TenantContext,
      taskId: string,
      outcome: string,
      receipt?: Readonly<Record<string, unknown>>,
    ) {
      finished.push({ taskId, outcome, ...(receipt ? { receipt } : {}) });
      return ok({ chargedCredits: outcome === 'completed' ? 1 : 0, costMicroUsd: 50 });
    },
  };
  const surfaces: ChatSurfaceInput[] = [];
  const toolRuns: { name: string; args: Record<string, unknown>; key: string | null }[] = [];
  const service = new CopilotChatService({
    standing: async () => ({
      onTestList: true,
      copilotFlag: true,
      writeScope: 'read',
      poolClass: 'customers',
      ...options.standing,
    }),
    allowance: async () => ({ workspaceCredits: 1000, memberCredits: 1000 }),
    budget: budget as never,
    clientFor: () => client,
    surface: (input) => {
      surfaces.push(input);
      return {
        async runTool(name, args) {
          toolRuns.push({ name, args, key: input.idempotencyKey() });
          return { summary: 'ran', data: { items: [{ title: 'Homepage' }] } };
        },
      };
    },
    countTokens: async () => 500,
  });
  const turn = (
    message: string,
    confirmed: ChatTurnInput['confirmed'] = null,
    ctx = memberContext(),
  ) => service.chat(ctx, SCOPE, { message, confirmed });
  return { turn, requests, opened, finished, settled, released, surfaces, toolRuns };
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

describe('gates before any spend', () => {
  it('off the test list, flag off or no key = 404; not a member session = 403; nothing opened', async () => {
    for (const standing of [{ onTestList: false }, { copilotFlag: false }]) {
      const env = setup([], { standing });
      expect(await status(env.turn('my tasks'))).toMatch(/^404 /);
      expect(env.opened).toEqual([]);
    }
    const pat = setup([]);
    expect(
      await status(pat.turn('my tasks', null, memberContext({ actorChannel: 'ai_assistant' }))),
    ).toBe('403 copilot.chat:caller');
    const client = setup([]);
    expect(
      await status(client.turn('my tasks', null, memberContext({ principalKind: 'client' }))),
    ).toBe('403 copilot.chat:caller');
  });
});

describe('the rules pre-pass costs nothing', () => {
  it('answers "open calendar" from the palette registry with no task and no model call', async () => {
    const env = setup([]);
    const view = await env.turn('Open calendar');
    expect(view).toMatchObject({
      state: 'navigate',
      navigation: { href: '/calendar' },
      chargedCredits: 0,
    });
    expect(env.opened).toEqual([]);
    expect(env.requests).toEqual([]);
  });

  it('matches only exact titles or keywords', () => {
    expect(plainCommand(COMMAND_REGISTRY, 'go to people')?.href).toBe('/people');
    expect(plainCommand(COMMAND_REGISTRY, 'show me the board')?.href).toBe('/work');
    expect(plainCommand(COMMAND_REGISTRY, 'open the project for ABC and summarise it')).toBeNull();
    expect(plainCommand(COMMAND_REGISTRY, 'what is late?')).toBeNull();
  });
});

describe('a read answer', () => {
  it('routes, runs a read op through the surface as the member, answers, settles every call', async () => {
    const env = setup([
      route('tasks', 'low'),
      runAction('t1', 'work_items.list', { limit: 5 }),
      text('You have 1 task: Homepage.'),
    ]);
    const view = await env.turn('what are my tasks?');
    expect(view).toMatchObject({
      state: 'answer',
      answer: 'You have 1 task: Homepage.',
      tier: 'low',
    });
    expect(view.toolCalls).toEqual([{ opId: 'work_items.list', outcome: 'ok' }]);
    // Routed low: the routing task is the answering task (one task, three calls, all settled).
    expect(env.opened.map((o) => o.tier)).toEqual(['low']);
    expect(env.settled).toHaveLength(3);
    expect(env.toolRuns[0]).toMatchObject({
      name: META_TOOL_NAMES.run,
      args: { action_id: 'work_items.list', args: { limit: 5 } },
    });
    expect(env.toolRuns[0]?.key).toBe(idempotencyKeyOf('t1', env.toolRuns[0]?.args));
    // The receipt carries ops and outcomes, never the message or a tool result.
    const receipt = JSON.stringify(env.finished.at(-1)?.receipt);
    expect(receipt).toContain('work_items.list');
    expect(receipt).not.toContain('Homepage');
    expect(receipt).not.toContain('my tasks');
  });
});

describe('refused ops never run', () => {
  it('a write op is refused until the preview of 62-11, the model is told, nothing runs', async () => {
    const env = setup([
      route('tasks', 'medium'),
      runAction('t1', 'work_items.create', { title: 'x' }),
      text('I could not create it.'),
    ]);
    const view = await env.turn('create a task called x');
    expect(view.toolCalls).toEqual([{ opId: 'work_items.create', outcome: 'refused' }]);
    expect(env.toolRuns).toEqual([]);
  });

  it('the AI never reaches its own routes', () => {
    expect(isAiSelfOp({ path: '/v1/organizations/:orgSlug/copilot/ask' })).toBe(true);
    expect(isAiSelfOp({ path: '/v1/organizations/:orgSlug/ai/credits/' })).toBe(true);
    expect(isAiSelfOp({ path: '/v1/organizations/:orgSlug/work-items/' })).toBe(false);
    expect(
      planToolCall(META_TOOL_NAMES.run, { action_id: 'copilot.ask.create', args_json: '{}' }),
    ).toMatchObject({ kind: 'refuse' });
    expect(planToolCall('drop_table', {})).toMatchObject({ kind: 'refuse' });
  });

  it('tools run only when stop_reason is tool_use', async () => {
    const env = setup([
      route('tasks', 'low'),
      reply('end_turn', [
        { type: 'text', text: 'Done.' },
        {
          type: 'tool_use',
          id: 't1',
          name: META_TOOL_NAMES.run,
          input: { action_id: 'work_items.list', args_json: '{}' },
        },
      ]),
    ]);
    const view = await env.turn('anything new?');
    expect(view.state).toBe('answer');
    expect(env.toolRuns).toEqual([]);
  });
});

describe('the loop stops', () => {
  it('at the tier’s tool-call budget, with nothing past it run', async () => {
    const budget = TOOL_CALLS_PER_TURN.low;
    const script = [route('tasks', 'low')];
    for (let i = 0; i <= budget; i += 1) script.push(runAction(`t${i}`, 'work_items.list'));
    const env = setup(script);
    const view = await env.turn('loop forever');
    expect(view).toMatchObject({ state: 'stopped', stop: 'tool_limit' });
    expect(env.toolRuns).toHaveLength(budget);
    expect(env.finished.at(-1)?.outcome).toBe('failed');
  });

  it('at the tier ceiling, naming the next tier and never opening it (no silent upgrade)', async () => {
    const env = setup([route('tasks', 'medium'), runAction('t1', 'work_items.list')], {
      refuseReserveAt: { call: 3, reason: 'tier_ceiling' },
    });
    const view = await env.turn('summarise every task');
    expect(view).toMatchObject({
      state: 'stopped',
      stop: 'tier_ceiling',
      tier: 'medium',
      suggestedTier: 'medium_high',
    });
    expect(env.opened.map((o) => o.tier)).toEqual(['low', 'medium']);
  });

  it('a provider error after sending settles the call in full and stops calmly', async () => {
    const env = setup([
      route('tasks', 'low'),
      new AiClientError('timeout', 'no response', true, true),
    ]);
    const view = await env.turn('my tasks');
    expect(view).toMatchObject({ state: 'stopped', stop: 'provider_error' });
    expect(env.settled.at(-1)).toMatchObject({ outputTokens: 1_024, cacheWrite1hTokens: 500 });
  });
});

describe('the tier and the model', () => {
  it('every call uses the model of its task’s tier; the router call is Haiku', async () => {
    const env = setup([route('files', 'medium'), text('Here is the summary.')]);
    await env.turn('what is in the brief?');
    expect(env.requests.map((r) => r.model)).toEqual([
      AI_TIER_SPECS.low.model,
      AI_TIER_SPECS.medium.model,
    ]);
  });

  it('a Sonnet tier asks first: an estimate, then the accepted tier runs without a second route', async () => {
    const env = setup([route('files', 'medium_high')]);
    const estimate = await env.turn('analyse the contract');
    expect(estimate).toMatchObject({ state: 'estimate', tier: 'medium_high', ceilingCredits: 120 });
    expect(env.opened.map((o) => o.tier)).toEqual(['low']);

    const confirmed = setup([text('The contract says…')]);
    const view = await confirmed.turn('analyse the contract', {
      tier: 'medium_high',
      domain: 'files',
    });
    expect(view).toMatchObject({ state: 'answer', tier: 'medium_high' });
    expect(confirmed.requests.map((r) => r.model)).toEqual([AI_TIER_SPECS.medium_high.model]);
  });

  it('only a tier that asks first can be sent back as confirmed', () => {
    expect(() =>
      parseChatBody({ message: 'x', confirmed: { tier: 'low', domain: 'tasks' } }),
    ).toThrow(ApiError);
    expect(() =>
      parseChatBody({ message: 'x', confirmed: { tier: 'high', domain: 'help' } }),
    ).toThrow(ApiError);
    expect(parseChatBody({ message: ' hi ' })).toEqual({ message: 'hi', confirmed: null });
    expect(() => parseChatBody({ message: '' })).toThrow(ApiError);
  });
});

describe('scopes never reach manage or billing', () => {
  it('read, or read + write, from the owner’s setting', async () => {
    expect(chatScopesFor('read')).toBe('tmanage:read');
    expect(chatScopesFor('read_write')).toBe('tmanage:read tmanage:write');
    for (const scopes of [chatScopesFor('read'), chatScopesFor('read_write')]) {
      expect(scopes.split(' ')).not.toContain('tmanage:manage');
      expect(scopes.split(' ')).not.toContain('tmanage:billing');
    }
    const env = setup([route('tasks', 'low'), runAction('t1', 'work_items.list'), text('ok')], {
      standing: { writeScope: 'read_write' },
    });
    await env.turn('tasks');
    expect(env.surfaces.map((s) => s.scopes)).toEqual(['tmanage:read tmanage:write']);
    expect(env.surfaces[0]?.orgSlug).toBe('northstar');
  });
});

describe('the router', () => {
  it('is one strict tool with a constant prompt; anything but one valid route is no route', () => {
    const request = routerRequest('hello');
    expect(request.tools.map((t) => t.name)).toEqual(['route']);
    expect(routerRequest('other').system).toEqual(request.system);
    expect(parseRoute(route('tasks', 'low'))).toEqual({ domain: 'tasks', tier: 'low' });
    expect(parseRoute(route('help', 'high'))).toEqual({ domain: 'help', tier: 'help' });
    expect(parseRoute(route('tasks', 'help'))).toEqual({ domain: 'tasks', tier: 'low' });
    expect(parseRoute(route('payroll', 'low'))).toBeNull();
    expect(parseRoute(text('tasks'))).toBeNull();
  });

  it('a message the router cannot place stops after one call', async () => {
    const env = setup([text('I am not sure.')]);
    const view = await env.turn('???');
    expect(view).toMatchObject({ state: 'stopped', stop: 'not_understood' });
    expect(env.requests).toHaveLength(1);
  });

  it('help answers without tools', async () => {
    const env = setup([route('help', 'help'), text('Settings are under your name.')]);
    await env.turn('where are settings?');
    expect(env.opened.map((o) => o.tier)).toEqual(['low', 'help']);
    expect(env.requests[1]?.tools).toEqual([]);
  });

  it('the chat tools are strict and end the cached prefix', () => {
    expect(CHAT_TOOLS.every((t) => t.inputSchema.additionalProperties === false)).toBe(true);
    expect(CHAT_TOOLS.at(-1)?.cache).toBe('1h');
  });
});
