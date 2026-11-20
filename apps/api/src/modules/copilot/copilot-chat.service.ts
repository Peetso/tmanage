import { createHash } from 'node:crypto';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { canonicalizeArgs } from '../mcp/internal-grant.js';
import type { CommandDefinition } from '../search/command-match.js';
import {
  AiClientError,
  type AiClient,
  type AiMessage,
  type AiRequest,
  type AiUserBlock,
} from './ai-client.js';
import type { AiUsage } from './ai-cost.js';
import type {
  AiBudgetRefusal,
  AiBudgetResult,
  AiBudgetService,
  AiCreditAllowance,
  OpenedTask,
} from './ai-budget.service.js';
import { callerClassOf } from './ai-budget.service.js';
import { CHAT_TOOLS, planToolCall } from './ai-chat-tools.js';
import { isPricedModel } from './ai-price-table.js';
import type { AiResponse } from './ai-response.js';
import {
  activityOf,
  isAiDomain,
  parseRoute,
  routerRequest,
  type AiDomain,
  type AiRoute,
} from './ai-router.js';
import { AI_TIER_SPECS, isAiTier, type AiSpendingPool, type AiTier } from './ai-tiers.js';
import { DOMAIN_PROMPT_VERSION, domainSystemPrompt } from './system-prompts/domains.js';
import { ROUTER_PROMPT_VERSION } from './system-prompts/router.js';

/**
 * 62-09 (plan 62 §4.1) — the orchestrator: one chat turn, server side.
 *
 * 1. **Gates before any spend:** an internal member on an ordinary session (403 otherwise), the
 *    workspace on the AI test list and the `copilot` flag on (404: the feature is absent), a key
 *    for the workspace's pool (404 too). Rate limits are 62-14; the budget hold comes next.
 * 2. **Rules pre-pass, no AI:** a plain navigation command ("open projects") is answered from the
 *    command palette's registry. No task, no hold, no cost.
 * 3. **Router:** one Haiku call under a `low` task names the domain and the tier. A tier that asks
 *    first (Sonnet) returns an estimate and stops; the member confirms by sending it back.
 * 4. **The loop:** the tier's model with the domain prompt and the chat tools; every model call is
 *    held, marked sent and settled through {@link AiBudgetService}; every tool call goes through
 *    `liveMcpSurface` as the member, with scopes from the owner's setting (`read`, or `read` +
 *    `write`; never `manage`, never `billing`). `stop_reason` is checked before any tool runs; the
 *    tier caps the tool calls of a turn; the tier is fixed (no silent upgrade: the tier ceiling
 *    stops the turn and names the next tier, it never opens one).
 * 5. Settle, write the receipt with the close, return.
 *
 * Every dependency is a port (IP-6), so the whole turn runs in unit tests against a scripted model.
 */

export const CHAT_MESSAGE_MAX_CHARS = 4_000;

/** Plan 62 §4.1 step 6: tool calls per turn by tier. Help answers without tools. */
export const TOOL_CALLS_PER_TURN: Readonly<Record<AiTier, number>> = Object.freeze({
  help: 0,
  low: 8,
  medium: 15,
  medium_high: 25,
  high: 25,
});

/** `max_tokens` per tier (provisional; the benchmark of §6 sets them). */
export const MAX_TOKENS_PER_TIER: Readonly<Record<AiTier, number>> = Object.freeze({
  help: 512,
  low: 1_024,
  medium: 2_048,
  medium_high: 4_096,
  high: 8_192,
});

/** The owner's write setting (`ai_workspace_settings.write_scope`). */
export type AiWriteScope = 'read' | 'read_write';

/** The OAuth scopes a turn's tools run under. Never `manage`, never `billing` (§4.1 step 5). */
export function chatScopesFor(writeScope: AiWriteScope): string {
  return writeScope === 'read_write' ? 'tmanage:read tmanage:write' : 'tmanage:read';
}

/** The next tier up, named when the tier ceiling stops a turn. */
export function nextTierOf(tier: AiTier): AiTier | null {
  switch (tier) {
    case 'help':
    case 'low':
      return 'medium';
    case 'medium':
      return 'medium_high';
    case 'medium_high':
      return 'high';
    default:
      return null;
  }
}

/** Hash(tool-use id + arguments): a retry of the same tool call carries the same key (§4.1). */
export function idempotencyKeyOf(toolUseId: string, args: unknown): string {
  return createHash('sha256')
    .update(`${toolUseId}\n${canonicalizeArgs(args)}`)
    .digest('hex');
}

export interface ChatStanding {
  readonly onTestList: boolean;
  readonly copilotFlag: boolean;
  readonly writeScope: AiWriteScope;
  readonly poolClass: AiSpendingPool;
}

export interface ChatToolResult {
  readonly isError?: boolean;
  readonly summary?: string;
  readonly data: unknown;
}

/** The member's tool surface for one task (`liveMcpSurface` in production). */
export interface ChatSurface {
  runTool(catalogTool: string, args: Record<string, unknown>): Promise<ChatToolResult>;
}

export interface ChatSurfaceInput {
  readonly context: TenantContext;
  /** The workspace of the route (`:orgSlug`), the only workspace the tools may reach. */
  readonly orgSlug: string;
  readonly scopes: string;
  /** Attribution of the inner calls (the task id). */
  readonly grantId: string;
  /** The idempotency key of the tool call being run, or `null` outside one. */
  readonly idempotencyKey: () => string | null;
}

export interface ChatNavigation {
  readonly title: string;
  readonly href: string;
}

/** What the route resolved for this request: its workspace and the commands this member is offered. */
export interface ChatRequestScope {
  readonly orgSlug: string;
  readonly commands: readonly CommandDefinition[];
}

const PLAIN_COMMAND = /^(?:open|go to|show(?: me)?)\s+(?:the\s+|my\s+)?(.+?)[.!]?$/i;

/**
 * The rules pre-pass (plan §4.1 step 2): "open projects", "go to calendar" — a plain navigation
 * command that names one palette entry exactly (its title without "Go to", or a keyword). Anything
 * looser goes to the model; the command list is the palette's own, so no link is ever invented.
 */
export function plainCommand(
  commands: readonly CommandDefinition[],
  message: string,
): ChatNavigation | null {
  const match = PLAIN_COMMAND.exec(message.trim());
  const target = match?.[1]?.trim().toLowerCase();
  if (target === undefined || target === '') return null;
  const found = commands.find(
    (command) =>
      command.kind === 'navigate' &&
      command.href !== null &&
      (command.title.toLowerCase().replace(/^go to\s+/, '') === target ||
        command.keywords.some((keyword) => keyword.toLowerCase() === target)),
  );
  return found?.href ? { title: found.title, href: found.href } : null;
}

export interface CopilotChatDeps {
  readonly standing: (context: TenantContext) => Promise<ChatStanding>;
  readonly allowance: (context: TenantContext) => Promise<AiCreditAllowance>;
  readonly budget: Pick<
    AiBudgetService,
    'openTask' | 'reserveCall' | 'markSent' | 'settleCall' | 'releaseCall' | 'finishTask'
  >;
  /** The model client of a pool, or `null` when no key is set for it. */
  readonly clientFor: (pool: AiSpendingPool) => AiClient | null;
  readonly surface: (input: ChatSurfaceInput) => ChatSurface;
  /** The prompt size of a request (`count_tokens`); defaults to a byte-length upper estimate. */
  readonly countTokens?: (request: AiRequest) => Promise<number>;
}

export interface ChatTurnInput {
  readonly message: string;
  /** The estimate the member accepted: its tier and domain, sent back unchanged. */
  readonly confirmed: AiRoute | null;
}

export type ChatStop =
  AiBudgetRefusal | 'tool_limit' | 'provider_error' | 'model_refused' | 'not_understood';

export interface ChatToolRecord {
  readonly opId: string | null;
  readonly outcome: 'ok' | 'error' | 'refused';
}

/** `POST …/copilot/chat` — no web client yet (62-15). */
export interface CopilotChatView {
  readonly state: 'answer' | 'navigate' | 'estimate' | 'stopped';
  readonly answer: string | null;
  readonly navigation: ChatNavigation | null;
  readonly domain: AiDomain | null;
  readonly tier: AiTier | null;
  /** On `estimate`: the most the turn can cost, in credits. */
  readonly ceilingCredits: number | null;
  /** On `stopped`: why; on a tier stop, the tier that could do it. */
  readonly stop: ChatStop | null;
  readonly suggestedTier: AiTier | null;
  readonly truncated: boolean;
  readonly toolCalls: readonly ChatToolRecord[];
  readonly chargedCredits: number;
}

const EMPTY_VIEW: Omit<CopilotChatView, 'state'> = {
  answer: null,
  navigation: null,
  domain: null,
  tier: null,
  ceilingCredits: null,
  stop: null,
  suggestedTier: null,
  truncated: false,
  toolCalls: [],
  chargedCredits: 0,
};

/** The request body, parsed at the boundary (IP-2). */
export function parseChatBody(body: Readonly<Record<string, unknown>> | null): ChatTurnInput {
  const message = typeof body?.['message'] === 'string' ? body['message'].trim() : '';
  if (message.length === 0 || message.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new ApiError(400, 'validation_failed', 'Type a message.', [
      { field: 'message', message: `1 to ${CHAT_MESSAGE_MAX_CHARS} characters` },
    ]);
  }
  const raw = body?.['confirmed'];
  if (raw === undefined || raw === null) return { message, confirmed: null };
  const record = typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { tier, domain } = record;
  if (
    typeof tier !== 'string' ||
    !isAiTier(tier) ||
    !AI_TIER_SPECS[tier].asksFirst ||
    !isAiDomain(domain) ||
    domain === 'help'
  ) {
    throw new ApiError(400, 'validation_failed', 'Send back the estimate you accepted.', [
      { field: 'confirmed', message: 'a tier that asks first and its domain' },
    ]);
  }
  return { message, confirmed: { tier, domain } };
}

const notFound = (auditCode: string) =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);

/** A byte-length upper estimate of a request's prompt tokens (a token is never under a byte). */
async function bytesAsTokens(request: AiRequest): Promise<number> {
  const { model: _model, maxTokens: _max, ...prompt } = request;
  return Buffer.byteLength(JSON.stringify(prompt), 'utf8');
}

type CallOutcome =
  | { readonly ok: true; readonly response: AiResponse }
  | { readonly ok: false; readonly stop: ChatStop };

interface TurnState {
  readonly task: OpenedTask;
  readonly client: AiClient;
  calls: number;
}

export class CopilotChatService {
  private readonly countTokens: (request: AiRequest) => Promise<number>;

  constructor(private readonly deps: CopilotChatDeps) {
    this.countTokens = deps.countTokens ?? bytesAsTokens;
  }

  async chat(
    context: TenantContext,
    scope: ChatRequestScope,
    input: ChatTurnInput,
  ): Promise<CopilotChatView> {
    const { orgSlug } = scope;
    // 1. Gates before any spend.
    if (callerClassOf(context).kind !== 'member') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'copilot.chat:caller');
    }
    const standing = await this.deps.standing(context);
    if (!standing.onTestList) throw notFound('copilot.chat:not_on_test_list');
    if (!standing.copilotFlag) throw notFound('copilot.chat:flag_off');
    const client = this.deps.clientFor(standing.poolClass);
    if (client === null) throw notFound('copilot.chat:no_key');

    // 2. Rules pre-pass: a plain command costs nothing.
    const navigation =
      input.confirmed === null ? plainCommand(scope.commands, input.message) : null;
    if (navigation) return { ...EMPTY_VIEW, state: 'navigate', navigation };

    const allowance = await this.deps.allowance(context);

    // 3. The route: the accepted estimate, or one router call under a low task.
    let route: AiRoute;
    let routing: TurnState | null = null;
    if (input.confirmed !== null) {
      route = input.confirmed;
    } else {
      const opened = await this.open(context, 'low', 'tasks', allowance);
      if (!opened.ok) return this.stopped(null, null, opened.reason);
      routing = { task: opened.value, client, calls: 0 };
      const routed = await this.callModel(context, routing, routerRequest(input.message));
      const parsed = routed.ok ? parseRoute(routed.response) : null;
      if (parsed === null) {
        const finish = await this.finish(context, routing, routed.ok ? 'completed' : 'failed', {
          stop: routed.ok ? 'not_understood' : routed.stop,
        });
        return this.stopped(null, null, routed.ok ? 'not_understood' : routed.stop, finish);
      }
      route = parsed;
      const spec = AI_TIER_SPECS[route.tier];
      if (spec.asksFirst) {
        const charged = await this.finish(context, routing, 'completed', { route });
        return {
          ...EMPTY_VIEW,
          state: 'estimate',
          domain: route.domain,
          tier: route.tier,
          ceilingCredits: spec.ceilingCredits,
          chargedCredits: charged,
        };
      }
    }

    // The tier is fixed here for the rest of the turn.
    let turn: TurnState;
    let routingCharged = 0;
    if (routing !== null && route.tier === 'low') {
      turn = routing;
    } else {
      if (routing !== null)
        routingCharged = await this.finish(context, routing, 'completed', { route });
      const opened = await this.open(context, route.tier, activityOf(route.domain), allowance);
      if (!opened.ok) return this.stopped(route, null, opened.reason, routingCharged);
      turn = { task: opened.value, client, calls: 0 };
    }

    // 4. The loop.
    const result = await this.loop(
      context,
      orgSlug,
      turn,
      route,
      input.message,
      standing.writeScope,
    );
    const charged = await this.finish(
      context,
      turn,
      result.stop === null ? 'completed' : 'failed',
      {
        route,
        stop: result.stop,
        toolCalls: result.toolCalls,
      },
    );
    const total = routingCharged + charged;
    if (result.stop !== null) {
      return {
        ...this.stopped(route, result.toolCalls, result.stop, total),
        suggestedTier: result.stop === 'tier_ceiling' ? nextTierOf(route.tier) : null,
      };
    }
    return {
      ...EMPTY_VIEW,
      state: 'answer',
      answer: result.answer,
      domain: route.domain,
      tier: route.tier,
      truncated: result.truncated,
      toolCalls: result.toolCalls,
      chargedCredits: total,
    };
  }

  private async loop(
    context: TenantContext,
    orgSlug: string,
    turn: TurnState,
    route: AiRoute,
    message: string,
    writeScope: AiWriteScope,
  ): Promise<{
    answer: string | null;
    truncated: boolean;
    stop: ChatStop | null;
    toolCalls: ChatToolRecord[];
  }> {
    const tier = turn.task.tier;
    const toolBudget = TOOL_CALLS_PER_TURN[tier];
    const tools = route.domain === 'help' ? [] : CHAT_TOOLS;
    const messages: AiMessage[] = [{ role: 'user', content: message }];
    const toolCalls: ChatToolRecord[] = [];
    let currentKey: string | null = null;
    const surface = this.deps.surface({
      context,
      orgSlug,
      scopes: chatScopesFor(writeScope),
      grantId: turn.task.taskId,
      idempotencyKey: () => currentKey,
    });

    // Each round is one model call; a round runs tools only on `tool_use`. Bounded by the budget.
    for (let round = 0; round <= toolBudget; round += 1) {
      const request: AiRequest = {
        model: AI_TIER_SPECS[tier].model,
        maxTokens: MAX_TOKENS_PER_TIER[tier],
        effort: tier === 'low' || tier === 'help' ? 'low' : 'medium',
        system: [{ text: domainSystemPrompt(route.domain), cache: '1h' }],
        tools,
        messages,
        cacheConversation: '5m',
      };
      const called = await this.callModel(context, turn, request);
      if (!called.ok) return { answer: null, truncated: false, stop: called.stop, toolCalls };
      const response = called.response;
      if (response.stopReason === 'refusal') {
        return { answer: null, truncated: false, stop: 'model_refused', toolCalls };
      }
      // stop_reason decides: tools run only when the model stopped to call them.
      if (response.stopReason !== 'tool_use') {
        return {
          answer: textOf(response),
          truncated: response.stopReason === 'max_tokens',
          stop: null,
          toolCalls,
        };
      }
      const uses = response.content.filter(
        (b): b is Extract<AiResponse['content'][number], { type: 'tool_use' }> =>
          b.type === 'tool_use',
      );
      if (tools.length === 0 || toolCalls.length + uses.length > toolBudget) {
        return { answer: textOf(response), truncated: false, stop: 'tool_limit', toolCalls };
      }
      const results: AiUserBlock[] = [];
      for (const use of uses) {
        const plan = planToolCall(use.name, use.input);
        if (plan.kind === 'refuse') {
          toolCalls.push({ opId: plan.opId, outcome: 'refused' });
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: plan.message,
            isError: true,
          });
          continue;
        }
        currentKey = idempotencyKeyOf(use.id, plan.args);
        let ran: ChatToolResult;
        try {
          ran = await surface.runTool(plan.catalogTool, plan.args);
        } finally {
          currentKey = null;
        }
        toolCalls.push({ opId: plan.opId, outcome: ran.isError === true ? 'error' : 'ok' });
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: toolResultText(ran),
          ...(ran.isError === true ? { isError: true } : {}),
        });
      }
      messages.push({ role: 'assistant', content: response.replay });
      messages.push({ role: 'user', content: results });
    }
    return { answer: null, truncated: false, stop: 'tool_limit', toolCalls };
  }

  /** Hold, send, settle one model call. The model is always the task's (the tier's). */
  private async callModel(
    context: TenantContext,
    turn: TurnState,
    request: AiRequest,
  ): Promise<CallOutcome> {
    const promptTokens = await this.countTokens(request);
    const reserved = await this.deps.budget.reserveCall(context, {
      taskId: turn.task.taskId,
      promptTokens,
      maxTokens: request.maxTokens,
    });
    if (!reserved.ok) return { ok: false, stop: reserved.reason };
    const { callId, model } = reserved.value;
    if (!isPricedModel(model)) throw new Error(`unpriced model ${model}`);
    const sent = await this.deps.budget.markSent(context, callId);
    if (!sent.ok) {
      await this.deps.budget.releaseCall(context, callId);
      return { ok: false, stop: sent.reason };
    }
    turn.calls += 1;
    try {
      const response = await turn.client.call({ ...request, model });
      must(
        await this.deps.budget.settleCall(context, {
          callId,
          usage: response.usage,
          toolCalls: response.content.filter((b) => b.type === 'tool_use').length,
          latencyMs: response.latencyMs,
          stopReason: response.stopReason,
          providerMessageId: response.id,
        }),
      );
      return { ok: true, response };
    } catch (error) {
      if (!(error instanceof AiClientError)) throw error;
      // Sent with an unknown result: settled in full at the hold (plan §5); never sent: released.
      must(
        await this.deps.budget.settleCall(context, {
          callId,
          usage: error.sent ? worstCase(promptTokens, request.maxTokens) : NO_USAGE,
          toolCalls: 0,
          latencyMs: null,
          stopReason: null,
          providerMessageId: null,
        }),
      );
      return { ok: false, stop: 'provider_error' };
    }
  }

  private async open(
    context: TenantContext,
    tier: AiTier,
    activity: ReturnType<typeof activityOf>,
    allowance: AiCreditAllowance,
  ): Promise<AiBudgetResult<OpenedTask>> {
    return this.deps.budget.openTask(context, { tier, activity, allowance });
  }

  /** Close the task with its receipt; the credits charged. */
  private async finish(
    context: TenantContext,
    turn: TurnState,
    outcome: 'completed' | 'failed',
    details: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const receipt = {
      version: 1,
      prompts: { router: ROUTER_PROMPT_VERSION, domains: DOMAIN_PROMPT_VERSION },
      tier: turn.task.tier,
      model: turn.task.model,
      pool: turn.task.pool,
      modelCalls: turn.calls,
      ...details,
    };
    const finished = await this.deps.budget.finishTask(context, turn.task.taskId, outcome, receipt);
    return finished.ok ? finished.value.chargedCredits : 0;
  }

  private stopped(
    route: AiRoute | null,
    toolCalls: readonly ChatToolRecord[] | null,
    stop: ChatStop,
    chargedCredits = 0,
  ): CopilotChatView {
    return {
      ...EMPTY_VIEW,
      state: 'stopped',
      domain: route?.domain ?? null,
      tier: route?.tier ?? null,
      stop,
      toolCalls: toolCalls ?? [],
      chargedCredits,
    };
  }
}

const NO_USAGE: AiUsage = {
  inputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
};

/** The usage the hold was computed from (`worstCaseHoldMicroUsd`): settling it costs the hold. */
function worstCase(promptTokens: number, maxTokens: number): AiUsage {
  return { ...NO_USAGE, cacheWrite1hTokens: promptTokens, outputTokens: maxTokens };
}

function must(result: AiBudgetResult<unknown>): void {
  if (!result.ok) throw new Error(`ai budget refused to settle a call: ${result.reason}`);
}

function textOf(response: AiResponse): string | null {
  const text = response.content
    .filter((b): b is Extract<AiResponse['content'][number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text === '' ? null : text;
}

function toolResultText(result: ChatToolResult): string {
  const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null);
  return result.summary === undefined ? data : `${result.summary}\n${data}`;
}
