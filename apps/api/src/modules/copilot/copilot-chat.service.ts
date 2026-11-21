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
  type AiToolDefinition,
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
import { currentValues, readTarget, runChange, undoPossible } from './ai-change.js';
import { billingCardAmount, billingCardWarnings } from './packs/billing.js';
import type { BillingRead } from './packs/billing.js';
import type { AiChangeState } from './ai-change.repository.js';
import { CHAT_TOOLS, META_TOOL_NAMES, planToolCall } from './ai-chat-tools.js';
import { packTools } from './packs/index.js';
import {
  FILE_READ_OP,
  RECORD_FILE_SUMMARY_TOOL,
  RECORD_FILE_SUMMARY_TOOL_DEFINITION,
  SCAN_MAX_PAGES,
  fileContextText,
  fileReadOf,
  offersSummary,
  planFileQuestion,
} from './packs/files.js';
import type { ScanSourceResult } from './knowledge/file-scan-source.js';
import {
  EXPLAIN_DEFAULT_MESSAGE,
  EXPLAIN_DOMAIN,
  EXPLAIN_SIGNAL_TOOL_DEFINITION,
  explainMessage,
  parseExplain,
  type ExplainRequest,
} from './packs/signals.js';
import {
  RECALL_MEMORY_TOOL,
  RECALL_MEMORY_TOOL_DEFINITION,
  recalledFactSources,
} from './packs/business-memory.js';
import {
  FILE_PASSAGES_TOOL,
  KNOWLEDGE_TOOL,
  SEARCH_FILE_PASSAGES_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  filePassageSources,
  knowledgeSources,
  validateRecordLinks,
} from './packs/knowledge.js';
import type { ChatConversations, ChatHistoryMessage } from './ai-conversations.service.js';
import type { AiToolCallAudit, ChatAudit } from './ai-audit.js';
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
import { AI_UNDO_WINDOW_MS, recordOf, type AiUndoEntry } from './ai-undo.js';
import { isPricedModel } from './ai-price-table.js';
import { historyReplay, type AiResponse } from './ai-response.js';
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
/** 62-25: the question as the file route's `q` (its cap). */
export const FILE_QUESTION_QUERY_MAX_CHARS = 300;

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
  /** 62-13: the member's conversations (history in, answered turns recorded). */
  readonly conversations?: ChatConversations;
  /**
   * 62-14: the abuse limits (a member 10 a minute and 200 a day, a workspace 60 a minute), asked
   * before any task is opened so a refused turn leaves no hold. Absent = not limited (unit tests).
   */
  readonly limits?: (context: TenantContext) => Promise<ChatLimitDecision>;
  /** 62-14: one audit row per tool call and per turn, no text (best-effort: reads only). */
  readonly audit?: ChatAudit;
  /**
   * 62-14 (OWASP ASVS 5.0 V16): the fail-closed audit row of a change the AI runs at once, written
   * before the change runs; it throws when the row cannot be written, and then nothing runs.
   * Absent: run at once is off (every change needs a card, whose confirm audits fail closed).
   */
  readonly changeAudit?: (
    context: TenantContext,
    change: { readonly taskId: string; readonly opId: string },
  ) => Promise<void>;
  /**
   * 62-25: records the summary the model wrote of a file it read whole (the cache that makes the
   * next question about the same bytes cheap). Absent: no summary is offered or kept.
   */
  readonly fileSummaries?: ChatFileSummaries;
  /** 62-25: the bytes of a scanned PDF, only for a turn whose member accepted the scan read. */
  readonly fileScans?: ChatFileScans;
  readonly now?: () => Date;
}

/** 62-25: the summary cache of file questions (`FileKnowledgeService.recordSummary`). */
export interface ChatFileSummaries {
  record(
    context: TenantContext,
    summary: {
      readonly textId: string;
      readonly audience: 'internal' | 'client_visible' | 'client_action_required';
      readonly summary: string;
      readonly model: string;
    },
    now: Date,
  ): Promise<boolean>;
}

/** 62-25: a scanned PDF's bytes for the accepted scan read (`FileScanSource.read`). */
export interface ChatFileScans {
  read(context: TenantContext, fileAssetId: string, maxPages: number): Promise<ScanSourceResult>;
}

/** 62-25: a question about one file the member can open. */
export interface ChatFileQuestion {
  readonly fileId: string;
  /** The member accepted reading the scan with AI (sent back with the estimate). */
  readonly readScan: boolean;
}

export interface ChatTurnInput {
  readonly message: string;
  /** The estimate the member accepted: its tier and domain, sent back unchanged. */
  readonly confirmed: AiRoute | null;
  /** The help button (62-10): straight to the free help path, no router call. */
  readonly help?: boolean;
  /** 62-13: the member's own conversation this turn continues; absent = a new one. */
  readonly conversationId?: string | null;
  /** 62-28: "Explain this alert": a Low turn with no router call and the `explain_signal` tool. */
  readonly explain?: ExplainRequest | null;
  /** 62-25: the turn is a question about this file (no router call; the file decides the tier). */
  readonly file?: ChatFileQuestion | null;
}

export type ChatStop =
  | AiBudgetRefusal
  | 'tool_limit'
  | 'provider_error'
  | 'model_refused'
  | 'not_understood'
  | 'rate_limited'
  /** 62-25: the scan the member accepted cannot be read (see `file.reasonCode`). */
  | 'scan_unavailable';

/** 62-14: what the abuse limits said about one turn. */
export type ChatLimitDecision =
  { readonly admitted: true } | { readonly admitted: false; readonly retryAfterSeconds: number };

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
  /** 62-13: the conversation an answered turn was recorded in (send it back to continue). */
  readonly conversationId: string | null;
  /** 62-14: on `rate_limited`, the seconds until the member can ask again. */
  readonly retryAfterSeconds: number | null;
  /** 62-25: on a file question's estimate or scan stop, what to send back or why it stopped. */
  readonly file: ChatFileOffer | null;
}

/**
 * 62-25: the file of an estimate. `readScan` = the estimate offers reading the scan with AI: the
 * member accepts by sending `file: { fileId, readScan: true }` with `confirmed`.
 */
export interface ChatFileOffer {
  readonly fileId: string;
  readonly readScan: boolean;
  /** On `scan_unavailable`: why (`too_many_pages`, `too_large`, `not_pdf`, …). */
  readonly reasonCode: string | null;
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
  conversationId: null,
  retryAfterSeconds: null,
  file: null,
};

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request body, parsed at the boundary (IP-2). */
export function parseChatBody(body: Readonly<Record<string, unknown>> | null): ChatTurnInput {
  const explain = parseExplain(body?.['explain']);
  if (explain === undefined) {
    throw new ApiError(400, 'validation_failed', 'Send the alert to explain.', [
      { field: 'explain', message: 'an alert id and its group' },
    ]);
  }
  if (explain !== null) {
    // 62-28: the button's turn. Its own words are optional; never with help or an estimate.
    if (
      body?.['help'] === true ||
      (body?.['confirmed'] !== undefined && body['confirmed'] !== null)
    ) {
      throw new ApiError(400, 'validation_failed', 'An alert is explained on its own.', [
        { field: 'explain', message: 'not with help or an estimate' },
      ]);
    }
    const raw = typeof body?.['message'] === 'string' ? body['message'].trim() : '';
    if (raw.length > CHAT_MESSAGE_MAX_CHARS) {
      throw new ApiError(400, 'validation_failed', 'Type a message.', [
        { field: 'message', message: `1 to ${CHAT_MESSAGE_MAX_CHARS} characters` },
      ]);
    }
    const conversation = body?.['conversationId'];
    if (
      conversation !== undefined &&
      conversation !== null &&
      (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation))
    ) {
      throw new ApiError(400, 'validation_failed', 'Send back the conversation you are in.', [
        { field: 'conversationId', message: 'a conversation id' },
      ]);
    }
    return {
      message: raw === '' ? EXPLAIN_DEFAULT_MESSAGE : raw,
      confirmed: null,
      conversationId: typeof conversation === 'string' ? conversation.toLowerCase() : null,
      explain,
    };
  }
  const message = typeof body?.['message'] === 'string' ? body['message'].trim() : '';
  if (message.length === 0 || message.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new ApiError(400, 'validation_failed', 'Type a message.', [
      { field: 'message', message: `1 to ${CHAT_MESSAGE_MAX_CHARS} characters` },
    ]);
  }
  const help = body?.['help'] === true;
  const rawConversation = body?.['conversationId'];
  if (
    rawConversation !== undefined &&
    rawConversation !== null &&
    (typeof rawConversation !== 'string' || !CONVERSATION_ID.test(rawConversation))
  ) {
    throw new ApiError(400, 'validation_failed', 'Send back the conversation you are in.', [
      { field: 'conversationId', message: 'a conversation id' },
    ]);
  }
  const conversationId = typeof rawConversation === 'string' ? rawConversation.toLowerCase() : null;
  const file = parseFileQuestion(body?.['file']);
  if (file === undefined) {
    throw new ApiError(400, 'validation_failed', 'Send the file you are asking about.', [
      { field: 'file', message: 'a file id, and readScan only as true or false' },
    ]);
  }
  if (file !== null && help) {
    throw new ApiError(400, 'validation_failed', 'A help question is not about a file.', [
      { field: 'file', message: 'not with help' },
    ]);
  }
  const raw = body?.['confirmed'];
  if (raw === undefined || raw === null) {
    if (file?.readScan === true) {
      throw new ApiError(400, 'validation_failed', 'Send back the estimate you accepted.', [
        { field: 'confirmed', message: 'reading a scan needs the accepted estimate' },
      ]);
    }
    return { message, confirmed: null, help, conversationId, ...(file === null ? {} : { file }) };
  }
  if (help) {
    throw new ApiError(400, 'validation_failed', 'A help question has no estimate.', [
      { field: 'confirmed', message: 'not with help' },
    ]);
  }
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
  if (file !== null && domain !== 'files') {
    throw new ApiError(400, 'validation_failed', 'Send back the estimate you accepted.', [
      { field: 'confirmed', message: 'a file question is in the files domain' },
    ]);
  }
  return {
    message,
    confirmed: { tier, domain },
    conversationId,
    ...(file === null ? {} : { file }),
  };
}

const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 62-25: `file` of the body: `null` when absent, `undefined` when malformed. */
function parseFileQuestion(raw: unknown): ChatFileQuestion | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const fileId = record['fileId'];
  const readScan = record['readScan'] ?? false;
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId) || typeof readScan !== 'boolean') {
    return undefined;
  }
  return { fileId, readScan };
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

/**
 * 62-25: the prompt tokens one PDF page is held at when the model reads it as pages (its text and
 * its image). A provisional upper bound until Gate B measures real scans with `count_tokens`.
 */
export const DOCUMENT_PAGE_TOKENS = 5_000;

/**
 * A byte-length upper estimate of a request's prompt tokens (a token is never under a byte). A
 * document block counts {@link DOCUMENT_PAGE_TOKENS} a page, not its base64 bytes.
 */
export async function bytesAsTokens(request: AiRequest): Promise<number> {
  const { model: _model, maxTokens: _max, ...prompt } = request;
  let pages = 0;
  const messages = prompt.messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'document') return block;
        pages += block.pages;
        return { ...block, data: '' };
      }),
    };
  });
  return (
    Buffer.byteLength(JSON.stringify({ ...prompt, messages }), 'utf8') +
    pages * DOCUMENT_PAGE_TOKENS
  );
}

type CallOutcome =
  | { readonly ok: true; readonly response: AiResponse }
  | { readonly ok: false; readonly stop: ChatStop };

interface TurnState {
  readonly task: OpenedTask;
  readonly client: AiClient;
  calls: number;
  /** 62-14: the tokens the provider reported, for the turn's audit row. */
  inputTokens: number;
  outputTokens: number;
  /** 62-14: every tool call of the turn, redacted, for its audit rows. */
  readonly audited: AiToolCallAudit[];
}

const newTurn = (task: OpenedTask, client: AiClient): TurnState => ({
  task,
  client,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  audited: [],
});

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

/** 62-25: a server-side tool of one turn; its arguments are the model's, its keys the server's. */
type LocalTool = (args: Readonly<Record<string, unknown>>) => Promise<{
  readonly ok: boolean;
  readonly text: string;
}>;

interface LoopExtras {
  /** 62-28/62-25: a turn's own tools, before the meta-tools. */
  readonly tools?: readonly AiToolDefinition[];
  /** 62-25: how this turn runs its own tools (by name). */
  readonly local?: ReadonlyMap<string, LocalTool>;
  /** 62-25: what the first message carries before the question (a file, marked untrusted). */
  readonly lead?: {
    readonly blocks: readonly AiUserBlock[];
    readonly opId: string;
    readonly text: string;
  };
  /** 62-25: reads made for the turn before it opened (the file), in its tool records. */
  readonly priorCalls?: readonly ChatToolRecord[];
}

interface LoopResult {
  readonly answer: string | null;
  readonly truncated: boolean;
  readonly stop: ChatStop | null;
  readonly toolCalls: ChatToolRecord[];
  readonly changes: TurnChanges;
  readonly withheldFigures: number;
  readonly inertLinks: number;
  readonly unverifiedLinks: number;
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
    const askedAt = this.now();
    // 1. Gates before any spend.
    const standing = await openStanding(context, this.deps.standing);
    const client = this.deps.clientFor(standing.poolClass);
    if (client === null) throw notFound('copilot.chat:no_key');
    // 62-13: a conversation the turn continues must be the member's own (404 otherwise).
    const conversationId = input.conversationId ?? null;
    let history: readonly ChatHistoryMessage[] = [];
    if (conversationId !== null) {
      const read =
        this.deps.conversations === undefined
          ? null
          : await this.deps.conversations.history(context, conversationId);
      if (read === null) throw notFound('copilot.chat:conversation_not_own');
      history = read;
    }

    // 2. Rules pre-pass: a plain command costs nothing.
    const navigation =
      input.confirmed === null &&
      input.help !== true &&
      (input.explain ?? null) === null &&
      (input.file ?? null) === null
        ? plainCommand(scope.commands, input.message)
        : null;
    if (navigation) return { ...EMPTY_VIEW, state: 'navigate', navigation };

    // 62-14: the abuse limits, before any task is opened (a refused turn holds nothing).
    if (this.deps.limits !== undefined) {
      const limit = await this.deps.limits(context);
      if (!limit.admitted) {
        return {
          ...this.stopped(null, null, 'rate_limited'),
          retryAfterSeconds: limit.retryAfterSeconds,
        };
      }
    }

    const allowance = await this.deps.allowance(context);

    // 62-25: a question about one file: the file decides the tier, never a router call.
    if ((input.file ?? null) !== null) {
      return this.fileQuestion(context, scope, input, input.file!, standing, history, allowance);
    }

    // 3. The route: the accepted estimate, or one router call under a low task.
    let route: AiRoute;
    let routing: TurnState | null = null;
    const explain = input.explain ?? null;
    if (input.help === true) {
      // The free-support path: no router, the platform-paid help tier (20 a member a day).
      route = { domain: 'help', tier: 'help' };
    } else if (explain !== null) {
      // 62-28: "Explain this alert" is always Low, no router call; the group picks the read pack.
      route = { domain: EXPLAIN_DOMAIN[explain.group], tier: 'low' };
    } else if (input.confirmed !== null) {
      route = input.confirmed;
    } else {
      const opened = await this.open(context, 'low', 'tasks', allowance);
      if (!opened.ok) return this.stopped(null, null, opened.reason);
      routing = newTurn(opened.value, client);
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
      turn = newTurn(opened.value, client);
    }

    // 4. The loop.
    const result = await this.loop(
      context,
      orgSlug,
      turn,
      route,
      explain === null ? input.message : explainMessage(input.message, explain),
      standing,
      history,
      explain === null ? {} : { tools: [EXPLAIN_SIGNAL_TOOL_DEFINITION] },
    );
    return this.conclude(
      context,
      turn,
      route,
      input,
      result,
      conversationId,
      askedAt,
      routingCharged,
    );
  }

  /** The end of an answered or stopped turn: card, receipt, conversation, view. */
  private async conclude(
    context: TenantContext,
    turn: TurnState,
    route: AiRoute,
    input: ChatTurnInput,
    result: LoopResult,
    conversationId: string | null,
    askedAt: Date,
    routingCharged: number,
  ): Promise<CopilotChatView> {
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
        unverifiedLinks: result.unverifiedLinks,
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
    // 62-13: an answered turn is kept in the member's conversation (the guarded answer they saw).
    const recordedIn =
      result.answer === null || this.deps.conversations === undefined
        ? null
        : await this.deps.conversations.record(context, {
            conversationId,
            message: input.message,
            answer: result.answer,
            taskId: turn.task.taskId,
            askedAt,
          });
    return {
      ...EMPTY_VIEW,
      state: card === null ? 'answer' : 'preview',
      answer: result.answer,
      conversationId: recordedIn,
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

  /**
   * 62-25 — a question about one file (`packs/files.ts`). The file is read first through the
   * member's own route (`knowledge.files.get`: the file's read rule; 404 when they cannot open
   * it), before any task opens; its state decides the tier. A tier that asks first, and every
   * scan, stops at an estimate the member accepts; a scan is read only on that accepted turn.
   * The file's content reaches the model marked untrusted, and taints the turn.
   */
  private async fileQuestion(
    context: TenantContext,
    scope: ChatRequestScope,
    input: ChatTurnInput,
    question: ChatFileQuestion,
    standing: ChatStanding,
    history: readonly ChatHistoryMessage[],
    allowance: AiCreditAllowance,
  ): Promise<CopilotChatView> {
    const askedAt = this.now();
    const surface = this.deps.surface({
      context,
      orgSlug: scope.orgSlug,
      scopes: chatScopesFor(standing.writeScope),
      grantId: 'file-question',
      idempotencyKey: () => null,
    });
    const q = [...input.message].slice(0, FILE_QUESTION_QUERY_MAX_CHARS).join('');
    const ran = await surface.runTool(META_TOOL_NAMES.run, {
      action_id: FILE_READ_OP,
      args: { fileAssetId: question.fileId, q },
    });
    const file = ran.isError === true ? null : fileReadOf(ran.data);
    if (file === null || file.fileId !== question.fileId)
      throw notFound('copilot.chat:file_not_visible');
    const read: ChatToolRecord = { opId: FILE_READ_OP, outcome: 'ok' };
    const accepted =
      input.confirmed === null ? null : { tier: input.confirmed.tier, scan: question.readScan };
    const plan = planFileQuestion(file, accepted);
    const offer = (readScan: boolean, reasonCode: string | null = null): ChatFileOffer => ({
      fileId: file.fileId,
      readScan,
      reasonCode,
    });
    if (plan.kind === 'estimate') {
      return {
        ...EMPTY_VIEW,
        state: 'estimate',
        domain: 'files',
        tier: plan.tier,
        ceilingCredits: AI_TIER_SPECS[plan.tier].ceilingCredits,
        toolCalls: [read],
        file: offer(plan.scan),
      };
    }
    const route: AiRoute = { domain: 'files', tier: plan.tier };
    // The scan's bytes before any task opens: an unreadable scan costs nothing.
    let lead: AiUserBlock[] = [];
    if (plan.kind === 'scan') {
      const scan =
        this.deps.fileScans === undefined
          ? ({ ok: false, code: 'unreadable' } as const)
          : await this.deps.fileScans.read(context, file.fileId, SCAN_MAX_PAGES);
      if (!scan.ok) {
        return {
          ...this.stopped(route, [read], 'scan_unavailable'),
          file: offer(false, scan.code),
        };
      }
      lead = [
        { type: 'document', mediaType: 'application/pdf', data: scan.data, pages: scan.pages },
      ];
    }
    const opened = await this.open(context, route.tier, 'file_analysis', allowance);
    if (!opened.ok) return this.stopped(route, [read], opened.reason);
    const turn = newTurn(opened.value, this.deps.clientFor(standing.poolClass)!);
    turn.audited.push({
      tool: FILE_READ_OP,
      opId: FILE_READ_OP,
      outcome: 'ok',
      argsSha256: createHash('sha256')
        .update(JSON.stringify({ fileAssetId: file.fileId, q }))
        .digest('hex'),
      latencyMs: 0,
    });
    const local = new Map<string, LocalTool>();
    const summaries = this.deps.fileSummaries;
    const summarise = summaries !== undefined && offersSummary(file, plan);
    if (summarise) {
      local.set(RECORD_FILE_SUMMARY_TOOL, async (args) => {
        const summary = typeof args['summary'] === 'string' ? args['summary'] : '';
        const saved = await summaries.record(
          context,
          {
            textId: file.textId!,
            audience: file.audience,
            summary,
            model: AI_TIER_SPECS[turn.task.tier].model,
          },
          this.now(),
        );
        return saved
          ? { ok: true, text: 'Saved. Now answer the question.' }
          : { ok: false, text: 'Not saved (the file changed). Answer the question.' };
      });
    }
    const result = await this.loop(
      context,
      scope.orgSlug,
      turn,
      route,
      input.message,
      standing,
      history,
      {
        tools: summarise ? [RECORD_FILE_SUMMARY_TOOL_DEFINITION] : [],
        local,
        lead: { blocks: lead, opId: FILE_READ_OP, text: fileContextText(file, plan) },
        priorCalls: [read],
      },
    );
    return this.conclude(
      context,
      turn,
      route,
      input,
      result,
      input.conversationId ?? null,
      askedAt,
      0,
    );
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
    history: readonly ChatHistoryMessage[] = [],
    extras: LoopExtras = {},
  ): Promise<LoopResult> {
    const turnTools = extras.tools ?? [];
    const writeScope = standing.writeScope;
    const changes: TurnChanges = {
      proposals: [],
      ran: [],
      cannotUndo: false,
      // 62-13: an earlier answer may carry what an untrusted source said, and its taint is not
      // kept: a turn with history is tainted from the start (every change needs a card).
      // 62-25: so is a turn that opens with a file's content.
      tainted: history.length > 0 || extras.lead !== undefined,
      evidence: [
        ...history.map((m) => m.body),
        message,
        ...(extras.lead === undefined ? [] : [extras.lead.text]),
      ],
    };
    const end = (
      stop: ChatStop | null,
      answer: string | null = null,
      truncated = false,
    ): LoopResult => {
      // 62-22: a record link survives only when a tool returned that record this turn; checked
      // first, so the figure guard never reads a record id as a figure.
      const cited = answer === null ? null : validateRecordLinks(answer, changes.evidence);
      const guarded = cited === null ? null : guardAnswer(cited.text, changes.evidence);
      return {
        answer: guarded?.text ?? null,
        unverifiedLinks: cited?.unverifiedLinks ?? 0,
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
    // The domain's pack, then the meta-tools as the long-tail fallback (their last tool closes
    // the cached prefix); help has none.
    // 62-22: `search_knowledge` follows every pack, before the meta-tools.
    const tools =
      route.domain === 'help'
        ? []
        : [
            ...packTools(route.domain),
            KNOWLEDGE_TOOL,
            FILE_PASSAGES_TOOL,
            RECALL_MEMORY_TOOL_DEFINITION,
            ...turnTools,
            ...CHAT_TOOLS,
          ];
    const messages: AiMessage[] = [
      ...history.map((m): AiMessage =>
        m.role === 'member'
          ? { role: 'user', content: m.body }
          : { role: 'assistant', content: historyReplay(m.body) },
      ),
      {
        role: 'user',
        content:
          extras.lead === undefined
            ? message
            : [
                ...extras.lead.blocks,
                { type: 'text', text: markUntrusted(extras.lead.opId, extras.lead.text) },
                { type: 'text', text: message },
              ],
      },
    ];
    const toolCalls: ChatToolRecord[] = [...(extras.priorCalls ?? [])];
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
      const prior = extras.priorCalls?.length ?? 0;
      if (tools.length === 0 || toolCalls.length - prior + uses.length > toolBudget) {
        return end('tool_limit', textOf(response));
      }
      const results: AiUserBlock[] = [];
      for (const use of uses) {
        const startedAt = Date.now();
        const audit = (record: ChatToolRecord) =>
          turn.audited.push({
            tool: use.name,
            opId: record.opId,
            outcome: record.outcome,
            argsSha256: createHash('sha256').update(JSON.stringify(use.input)).digest('hex'),
            latencyMs: Date.now() - startedAt,
          });
        // 62-25: a server-side tool of this turn (never a registry op, never the model's keys).
        const local = extras.local?.get(use.name);
        if (local !== undefined) {
          const done = await local(use.input);
          toolCalls.push({ opId: null, outcome: done.ok ? 'ok' : 'error' });
          audit(toolCalls.at(-1)!);
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: done.text,
            ...(done.ok ? {} : { isError: true }),
          });
          continue;
        }
        const plan = planToolCall(use.name, use.input);
        if (plan.kind === 'change') {
          currentKey = idempotencyKeyOf(use.id, plan.rawArgs);
          let done;
          try {
            done = await this.change(
              context,
              surface,
              standing,
              changes,
              plan.opId,
              plan.rawArgs,
              turn.task.taskId,
            );
          } finally {
            currentKey = null;
          }
          toolCalls.push({ opId: plan.opId, outcome: done.outcome });
          audit(toolCalls.at(-1)!);
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
          audit(toolCalls.at(-1)!);
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
        audit(toolCalls.at(-1)!);
        // 62-22: search hits go to the model as numbered sources with their in-app paths.
        const sources =
          ran.isError === true
            ? null
            : use.name === SEARCH_KNOWLEDGE_TOOL
              ? knowledgeSources(ran.data)
              : use.name === SEARCH_FILE_PASSAGES_TOOL
                ? filePassageSources(ran.data)
                : use.name === RECALL_MEMORY_TOOL
                  ? recalledFactSources(ran.data)
                  : null;
        const resultText = sources ?? toolResultText(ran);
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
    taskId: string,
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
      runAtOnce: standing.runAtOnce && !changes.tainted && this.deps.changeAudit !== undefined,
      hasUndo: undoPossible(change, current),
    });
    if (gate === null) return refused(`${opId} does not change data.`);
    if (!gate.card) {
      // Its audit row first: a change whose record cannot be kept does not run (V16).
      try {
        await this.deps.changeAudit!(context, { taskId, opId: change.op.id });
      } catch {
        return refused(`${opId} could not be recorded in the audit log. Nothing was changed.`);
      }
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
    // 62-29: a billing op decides its own amount; a new expense is checked for a duplicate.
    const read: BillingRead = (id, args) => readTarget(surface, id, args);
    const amount = await billingCardAmount(change.op.id, change.args, recordOf(current), read);
    const warnings = await billingCardWarnings(change.op.id, change.args, read);
    const item = buildCardItem(changes.proposals.length, change, gate, current, approvalId, {
      ...(amount === undefined ? {} : { amount }),
      warnings,
    });
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
        'TManage. Tell the member what you proposed; do not ask for it again.' +
        warnings
          .map(
            (w) => ` It may repeat expense ${w.expenseIds.join(', ')}: say so before they confirm.`,
          )
          .join(''),
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
      turn.inputTokens +=
        response.usage.inputTokens +
        response.usage.cacheWrite5mTokens +
        response.usage.cacheWrite1hTokens +
        response.usage.cacheReadTokens;
      turn.outputTokens += response.usage.outputTokens;
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
    const charged = finished.ok ? finished.value.chargedCredits : 0;
    // 62-14: the turn's audit rows (one per tool call, one for the turn), no text.
    if (this.deps.audit !== undefined) {
      const route = details['route'] as AiRoute | undefined;
      const stop = details['stop'];
      await this.deps.audit.turn(context, {
        taskId: turn.task.taskId,
        model: turn.task.model,
        tier: turn.task.tier,
        domain: route?.domain ?? null,
        outcome,
        stop: typeof stop === 'string' ? stop : null,
        modelCalls: turn.calls,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        chargedCredits: charged,
        tainted: details['tainted'] === true,
        withheldFigures:
          typeof details['withheldFigures'] === 'number' ? details['withheldFigures'] : 0,
        toolCalls: turn.audited,
      });
    }
    return charged;
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
