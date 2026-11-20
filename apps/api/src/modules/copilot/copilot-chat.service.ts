import { createHash, randomUUID } from 'node:crypto';
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
import { guardAnswer } from './ai-answer-guard.js';
import { currentValues, runChange, undoPossible } from './ai-change.js';
import type { AiChangeState } from './ai-change.repository.js';
import { CHAT_TOOLS, META_TOOL_NAMES, planToolCall } from './ai-chat-tools.js';
import {
  AI_CARD_TTL_MS,
  MAX_CARD_ITEMS,
  buildCardItem,
  changeGateFor,
  signCard,
  validateChange,
  type CardItem,
  type CardPayloadItem,
} from './ai-preview.js';
import { AI_UNDO_WINDOW_MS, type AiUndoEntry } from './ai-undo.js';
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
import { isUntrustedOpId, markUntrusted } from './untrusted-sources.js';

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
 * 5. **Changes (62-11):** a change the model asks for is validated by the op's schema and gated by
 *    `changeGateFor`: by default it is not run but put on one server-built preview card (signed:
 *    the frozen arguments and their hash), which the member confirms through `AiChangeService`;
 *    with the owner's "run at once" an everyday change with an undo runs now, its undo captured.
 *    A confirm-class op is also frozen in `pending_ai_actions` for its card.
 * 6. **Untrusted content (62-12):** a read whose result may hold text other people wrote reaches
 *    the model marked as data (`markUntrusted`), and taints the turn: from then on every change
 *    needs a confirmed card, even with "run at once" on. The final answer passes the answer guard
 *    (inert links, ungrounded figures withheld) against what the tools returned.
 * 7. Settle, write the receipt (and the card or undo state) with the close, return.
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
  /** `ai_workspace_settings.run_at_once` (owner setting, default off). */
  readonly runAtOnce: boolean;
  readonly poolClass: AiSpendingPool;
}

/** Freezes a confirm-class op for its card (`pending_ai_actions`, 10 minutes); returns its id. */
export type ChatApprovalFreezer = (
  context: TenantContext,
  opId: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<string>;

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
  /**
   * The key preview cards are signed with. Absent (no session secret configured): no card can be
   * issued, so every change is refused and nothing changes.
   */
  readonly cardKey?: string;
  readonly freezeApproval?: ChatApprovalFreezer;
  readonly now?: () => Date;
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
  readonly outcome: 'ok' | 'error' | 'refused' | 'proposed';
}

/** The preview card of a turn: what the member sees and the signed card a confirm sends back. */
export interface ChatCardView {
  readonly taskId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly items: readonly CardItem[];
}

/** Changes that ran at once in a turn, and until when they can be undone. */
export interface ChatUndoView {
  readonly taskId: string;
  readonly until: string | null;
  /** A change ran that has no inverse: the turn cannot be undone. */
  readonly cannotBeUndone: boolean;
}

/** `POST …/copilot/chat` — no web client yet (62-15). */
export interface CopilotChatView {
  readonly state: 'answer' | 'navigate' | 'estimate' | 'stopped' | 'preview';
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
  /** Figures the answer guard withheld (no tool returned them). */
  readonly withheldFigures: number;
  readonly toolCalls: readonly ChatToolRecord[];
  readonly chargedCredits: number;
  /** On `preview`: the card the member confirms; nothing on it has run. */
  readonly card: ChatCardView | null;
  /** Changes that ran at once this turn. */
  readonly undo: ChatUndoView | null;
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
  withheldFigures: 0,
  toolCalls: [],
  chargedCredits: 0,
  card: null,
  undo: null,
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

/**
 * The gates every AI route shares (chat, confirm, undo): an internal member on an ordinary
 * session (403 otherwise), the workspace on the test list and the `copilot` flag on (404: the
 * feature is absent). Returns the standing it read.
 */
export async function openStanding(
  context: TenantContext,
  standing: (context: TenantContext) => Promise<ChatStanding>,
): Promise<ChatStanding> {
  if (callerClassOf(context).kind !== 'member') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'copilot.chat:caller');
  }
  const read = await standing(context);
  if (!read.onTestList) throw notFound('copilot.chat:not_on_test_list');
  if (!read.copilotFlag) throw notFound('copilot.chat:flag_off');
  return read;
}

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

/** What the changes of one turn left: card items to confirm and the changes that ran. */
interface TurnChanges {
  readonly proposals: { readonly item: CardItem; readonly frozen: CardPayloadItem }[];
  readonly ran: AiUndoEntry[];
  cannotUndo: boolean;
  /** The turn read an untrusted source: every change needs a card from here on (taint rule). */
  tainted: boolean;
  /** What the tools returned and the member wrote: the evidence figures are grounded in. */
  readonly evidence: string[];
}

interface LoopResult {
  readonly answer: string | null;
  readonly truncated: boolean;
  readonly stop: ChatStop | null;
  readonly toolCalls: ChatToolRecord[];
  readonly changes: TurnChanges;
  readonly withheldFigures: number;
  readonly inertLinks: number;
}

export class CopilotChatService {
  private readonly countTokens: (request: AiRequest) => Promise<number>;

  private readonly now: () => Date;

  constructor(private readonly deps: CopilotChatDeps) {
    this.countTokens = deps.countTokens ?? bytesAsTokens;
    this.now = deps.now ?? (() => new Date());
  }

  async chat(
    context: TenantContext,
    scope: ChatRequestScope,
    input: ChatTurnInput,
  ): Promise<CopilotChatView> {
    const { orgSlug } = scope;
    // 1. Gates before any spend.
    const standing = await openStanding(context, this.deps.standing);
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
    const result = await this.loop(context, orgSlug, turn, route, input.message, standing);
    const completed = result.stop === null;
    const card = completed ? this.card(context, turn, result.changes) : null;
    const changeState = this.changeState(result.changes, card);
    const charged = await this.finish(
      context,
      turn,
      completed ? 'completed' : 'failed',
      {
        route,
        stop: result.stop,
        toolCalls: result.toolCalls,
        tainted: result.changes.tainted,
        withheldFigures: result.withheldFigures,
        inertLinks: result.inertLinks,
      },
      changeState,
    );
    const total = routingCharged + charged;
    const undo = this.undoView(turn, result.changes, changeState);
    if (result.stop !== null) {
      return {
        ...this.stopped(route, result.toolCalls, result.stop, total),
        suggestedTier: result.stop === 'tier_ceiling' ? nextTierOf(route.tier) : null,
        undo,
      };
    }
    return {
      ...EMPTY_VIEW,
      state: card === null ? 'answer' : 'preview',
      answer: result.answer,
      domain: route.domain,
      tier: route.tier,
      truncated: result.truncated,
      withheldFigures: result.withheldFigures,
      toolCalls: result.toolCalls,
      chargedCredits: total,
      card: card === null ? null : card.view,
      undo,
    };
  }

  /** The signed card of a turn's proposals, or `null` when nothing waits for a confirm. */
  private card(
    context: TenantContext,
    turn: TurnState,
    changes: TurnChanges,
  ): { readonly cardId: string; readonly view: ChatCardView } | null {
    if (changes.proposals.length === 0 || this.deps.cardKey === undefined) return null;
    const cardId = randomUUID();
    const expiresAt = this.now().getTime() + AI_CARD_TTL_MS;
    const token = signCard(
      {
        v: 1,
        cardId,
        taskId: turn.task.taskId,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        userId: context.userId,
        expiresAt,
        items: changes.proposals.map((p) => p.frozen),
      },
      this.deps.cardKey,
    );
    return {
      cardId,
      view: {
        taskId: turn.task.taskId,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        items: changes.proposals.map((p) => p.item),
      },
    };
  }

  /** What `ai_tasks.undo_json` keeps: the card waiting, or the changes that ran. */
  private changeState(
    changes: TurnChanges,
    card: { readonly cardId: string } | null,
  ): AiChangeState | undefined {
    const ran = changes.ran.length > 0 || changes.cannotUndo;
    if (card === null && !ran) return undefined;
    return {
      v: 1,
      state: card !== null ? 'card' : 'done',
      card: card === null ? null : card.cardId,
      doneAt: ran ? this.now().toISOString() : null,
      entries: changes.ran,
      cannotUndo: changes.cannotUndo,
    };
  }

  private undoView(
    turn: TurnState,
    changes: TurnChanges,
    state: AiChangeState | undefined,
  ): ChatUndoView | null {
    if (state === undefined || state.doneAt === null) return null;
    return {
      taskId: turn.task.taskId,
      until: changes.cannotUndo
        ? null
        : new Date(Date.parse(state.doneAt) + AI_UNDO_WINDOW_MS).toISOString(),
      cannotBeUndone: changes.cannotUndo,
    };
  }

  private async loop(
    context: TenantContext,
    orgSlug: string,
    turn: TurnState,
    route: AiRoute,
    message: string,
    standing: ChatStanding,
  ): Promise<LoopResult> {
    const writeScope = standing.writeScope;
    const changes: TurnChanges = {
      proposals: [],
      ran: [],
      cannotUndo: false,
      tainted: false,
      evidence: [message],
    };
    const end = (
      stop: ChatStop | null,
      answer: string | null = null,
      truncated = false,
    ): LoopResult => {
      const guarded = answer === null ? null : guardAnswer(answer, changes.evidence);
      return {
        answer: guarded?.text ?? null,
        truncated,
        stop,
        toolCalls,
        changes,
        withheldFigures: guarded?.withheldFigures ?? 0,
        inertLinks: guarded?.inertLinks ?? 0,
      };
    };
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
      if (!called.ok) return end(called.stop);
      const response = called.response;
      if (response.stopReason === 'refusal') {
        return end('model_refused');
      }
      // stop_reason decides: tools run only when the model stopped to call them.
      if (response.stopReason !== 'tool_use') {
        return end(null, textOf(response), response.stopReason === 'max_tokens');
      }
      const uses = response.content.filter(
        (b): b is Extract<AiResponse['content'][number], { type: 'tool_use' }> =>
          b.type === 'tool_use',
      );
      if (tools.length === 0 || toolCalls.length + uses.length > toolBudget) {
        return end('tool_limit', textOf(response));
      }
      const results: AiUserBlock[] = [];
      for (const use of uses) {
        const plan = planToolCall(use.name, use.input);
        if (plan.kind === 'change') {
          currentKey = idempotencyKeyOf(use.id, plan.rawArgs);
          let done;
          try {
            done = await this.change(context, surface, standing, changes, plan.opId, plan.rawArgs);
          } finally {
            currentKey = null;
          }
          toolCalls.push({ opId: plan.opId, outcome: done.outcome });
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: done.text,
            ...(done.isError ? { isError: true } : {}),
          });
          continue;
        }
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
        const resultText = toolResultText(ran);
        changes.evidence.push(resultText);
        // An approval's outcome or a read of other people's text: marked as data, and taints.
        const untrusted =
          plan.catalogTool === META_TOOL_NAMES.checkApproval ||
          (plan.opId !== null && isUntrustedOpId(plan.opId));
        if (untrusted) changes.tainted = true;
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: untrusted ? markUntrusted(plan.opId ?? 'approval', resultText) : resultText,
          ...(ran.isError === true ? { isError: true } : {}),
        });
      }
      messages.push({ role: 'assistant', content: response.replay });
      messages.push({ role: 'user', content: results });
    }
    return end('tool_limit');
  }

  /**
   * One change the model asked for (62-11). Validated by the op's own schema; then either run at
   * once (owner setting, an everyday `write` with an undo) with its undo captured, or put on the
   * turn's card. The model reads a calm result either way; it never sees the card token.
   */
  private async change(
    context: TenantContext,
    surface: ChatSurface,
    standing: ChatStanding,
    changes: TurnChanges,
    opId: string,
    rawArgs: Record<string, unknown>,
  ): Promise<{ outcome: ChatToolRecord['outcome']; text: string; isError: boolean }> {
    const refused = (text: string) => ({ outcome: 'refused' as const, text, isError: true });
    if (standing.writeScope !== 'read_write') {
      return refused(
        `${opId} changes data. The workspace owner allows the assistant to read only.`,
      );
    }
    if (this.deps.cardKey === undefined) {
      return refused(`${opId} changes data and cannot be proposed here. Nothing was changed.`);
    }
    const change = validateChange(opId, rawArgs);
    if (change === null) return refused(`Invalid arguments for ${opId}. Nothing was changed.`);
    // The member may run it at all: the surface's own permitted list, as `run_action` decides.
    const described = await surface.runTool(META_TOOL_NAMES.describe, { action_id: opId });
    if (described.isError === true) return refused(`Unknown or not permitted action: ${opId}`);
    // The target as it is now: the card's "before", and whether the change could be undone.
    const current = await currentValues(surface, change);
    // The taint rule: after an untrusted read, nothing runs at once.
    const gate = changeGateFor(change.op, {
      runAtOnce: standing.runAtOnce && !changes.tainted,
      hasUndo: undoPossible(change, current),
    });
    if (gate === null) return refused(`${opId} does not change data.`);
    if (!gate.card) {
      const ran = await runChange(surface, change);
      if (ran.ok) {
        if (ran.undo === null) changes.cannotUndo = true;
        else changes.ran.push(ran.undo);
      }
      changes.evidence.push(JSON.stringify(change.args), toolResultText(ran.result));
      return {
        outcome: ran.ok ? 'ok' : 'error',
        text: toolResultText(ran.result),
        isError: !ran.ok,
      };
    }
    if (changes.proposals.length >= MAX_CARD_ITEMS) {
      return refused(`The card already holds ${MAX_CARD_ITEMS} changes; ${opId} was not proposed.`);
    }
    let approvalId: string | null = null;
    if (change.op.risk === 'confirm') {
      if (this.deps.freezeApproval === undefined) {
        return refused(`${opId} needs approval in TManage and cannot be proposed here.`);
      }
      approvalId = await this.deps.freezeApproval(context, change.op.id, change.args);
    }
    const item = buildCardItem(changes.proposals.length, change, gate, current, approvalId);
    // The card shows these values to the member: the answer may name them.
    changes.evidence.push(JSON.stringify(change.args));
    changes.proposals.push({
      item,
      frozen: { opId: change.op.id, args: change.args, argsSha256: change.argsSha256, approvalId },
    });
    return {
      outcome: 'proposed',
      text:
        `Proposed, not run: "${change.title}" is on a preview card the member confirms in ` +
        'TManage. Tell the member what you proposed; do not ask for it again.',
      isError: false,
    };
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
    changeState?: AiChangeState,
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
    const finished = await this.deps.budget.finishTask(
      context,
      turn.task.taskId,
      outcome,
      receipt,
      changeState === undefined ? undefined : { ...changeState },
    );
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
