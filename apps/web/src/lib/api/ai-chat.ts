import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import { REAUTH_HEADER } from './passkeys';

/**
 * TManage AI chat (plan 62, slice 62-15) — the web side of the routes slices 62-09…62-14 built in
 * `apps/api/src/modules/copilot/`:
 *
 * - `POST …/copilot/chat` one turn ({@link CopilotChatView}); 404 when the workspace has no
 *   TManage AI (not on the test list, flag off), 403 for a client or guest.
 * - `POST …/copilot/chat/confirm` runs a preview card the member confirmed; money and HR items
 *   need `x-reauth-token` (step-up), money items the amount typed back.
 * - `POST …/copilot/chat/tasks/:taskId/undo` undoes a turn's changes within 15 minutes.
 * - `GET/DELETE …/copilot/conversations[/:id]` the member's own past conversations.
 *
 * The shapes mirror the API's view interfaces field for field (`copilot-chat.service.ts`,
 * `ai-change.service.ts`, `ai-conversations.service.ts`); the server decides every gate, tier and
 * figure and the screen only draws what it is sent (AR-9).
 */

export type AiTier = 'help' | 'low' | 'medium' | 'medium_high' | 'high';
export type AiDomain =
  'tasks' | 'projects' | 'people' | 'clients' | 'time' | 'billing' | 'files' | 'help';
export type AiSensitivity = 'money' | 'hr' | 'external' | 'destructive' | 'none';

/** Why a turn stopped (`ChatStop` in the API: the budget's refusals plus the chat's own). */
export type ChatStop =
  | 'caller_not_allowed'
  | 'not_on_test_list'
  | 'free_support_used'
  | 'member_credits_used'
  | 'workspace_credits_used'
  | 'tier_ceiling'
  | 'platform_paused'
  | 'sonnet_unavailable'
  | 'tool_limit'
  | 'provider_error'
  | 'model_refused'
  | 'not_understood'
  | 'answer_cut_off'
  | 'no_answer'
  | 'rate_limited'
  | 'scan_unavailable'
  | 'task_not_found'
  | 'task_not_running'
  | 'task_not_completed'
  | 'calls_open'
  | 'call_not_found'
  | 'call_not_reserved'
  | 'call_not_sent';

export interface ChatToolRecord {
  readonly opId: string | null;
  readonly outcome: 'ok' | 'error' | 'refused' | 'proposed';
}

export interface CardChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string;
}

export interface CardWarning {
  readonly code: 'possible_duplicate';
  readonly expenseIds: readonly string[];
}

/** One change on a preview card. Nothing on it has run. */
export interface CardItem {
  readonly index: number;
  readonly opId: string;
  readonly title: string;
  readonly sensitivity: AiSensitivity;
  readonly subject: string | null;
  readonly changes: readonly CardChange[];
  readonly stepUp: boolean;
  readonly typedAmount: boolean;
  readonly amount: number | null;
  readonly cannotBeUndone: boolean;
  readonly approvalId: string | null;
  readonly warnings: readonly CardWarning[];
}

export interface ChatCardView {
  readonly taskId: string;
  /** The signed card; sent back unchanged on confirm. Never shown. */
  readonly token: string;
  readonly expiresAt: string;
  readonly items: readonly CardItem[];
}

export interface ChatUndoView {
  readonly taskId: string;
  readonly until: string | null;
  readonly cannotBeUndone: boolean;
}

export interface ChatFileOffer {
  readonly fileId: string;
  readonly readScan: boolean;
  readonly reasonCode: string | null;
}

export interface ChatNavigation {
  readonly title: string;
  readonly href: string;
}

export interface CopilotChatView {
  readonly state: 'answer' | 'navigate' | 'estimate' | 'stopped' | 'preview';
  readonly answer: string | null;
  readonly navigation: ChatNavigation | null;
  readonly domain: AiDomain | null;
  readonly tier: AiTier | null;
  readonly ceilingCredits: number | null;
  readonly stop: ChatStop | null;
  readonly suggestedTier: AiTier | null;
  readonly truncated: boolean;
  readonly withheldFigures: number;
  readonly toolCalls: readonly ChatToolRecord[];
  readonly chargedCredits: number;
  readonly card: ChatCardView | null;
  readonly undo: ChatUndoView | null;
  readonly conversationId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly file: ChatFileOffer | null;
}

/** The estimate the member accepted: its tier and domain, sent back unchanged. */
export interface ChatConfirmedRoute {
  readonly tier: AiTier;
  readonly domain: AiDomain;
}

export interface ChatTurnRequest {
  readonly message: string;
  readonly confirmed?: ChatConfirmedRoute | null;
  readonly help?: boolean;
  readonly conversationId?: string | null;
  readonly explain?: { readonly signalId: string; readonly group: string } | null;
  readonly file?: { readonly fileId: string; readonly readScan: boolean } | null;
}

export type ConfirmedItemOutcome = 'done' | 'failed' | 'not_run';

export interface AiConfirmView {
  readonly taskId: string;
  readonly items: readonly {
    readonly index: number;
    readonly opId: string;
    readonly outcome: ConfirmedItemOutcome;
  }[];
  readonly undoUntil: string | null;
  readonly cannotBeUndone: boolean;
}

export interface AiUndoView {
  readonly taskId: string;
  readonly state: 'undone' | 'failed';
  readonly refundedCredits: number;
}

export interface AiConversationView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
}

export interface AiConversationListView {
  readonly items: readonly AiConversationView[];
  readonly retentionDays: number;
}

export interface AiConversationMessageView {
  readonly id: string;
  readonly role: 'member' | 'assistant';
  readonly body: string;
  readonly taskId: string | null;
  readonly createdAt: string;
}

export interface AiConversationDetailView {
  readonly conversation: AiConversationView;
  readonly messages: readonly AiConversationMessageView[];
}

const base = (slug: string) => `/v1/organizations/${encodeURIComponent(slug)}/copilot`;

export async function sendChatTurn(
  client: ApiClient,
  organizationSlug: string,
  turn: ChatTurnRequest,
): Promise<CopilotChatView> {
  const { data } = await client.request<CopilotChatView>({
    method: 'POST',
    path: `${base(organizationSlug)}/chat`,
    body: turn,
  });
  return data;
}

export async function confirmChatCard(
  client: ApiClient,
  organizationSlug: string,
  input: {
    readonly card: string;
    readonly amounts?: Readonly<Record<number, number>>;
    readonly reauthToken?: string;
  },
): Promise<AiConfirmView> {
  const { data } = await client.request<AiConfirmView>({
    method: 'POST',
    path: `${base(organizationSlug)}/chat/confirm`,
    body: { card: input.card, amounts: input.amounts ?? {} },
    ...(input.reauthToken === undefined ? {} : { headers: { [REAUTH_HEADER]: input.reauthToken } }),
  });
  return data;
}

export async function undoChatTask(
  client: ApiClient,
  organizationSlug: string,
  taskId: string,
): Promise<AiUndoView> {
  const { data } = await client.request<AiUndoView>({
    method: 'POST',
    path: `${base(organizationSlug)}/chat/tasks/${encodeURIComponent(taskId)}/undo`,
  });
  return data;
}

/** Also the panel's availability probe: 404 means the workspace has no TManage AI. */
export async function listAiConversations(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiConversationListView> {
  const { data } = await client.request<AiConversationListView>({
    path: `${base(organizationSlug)}/conversations`,
  });
  return data;
}

export async function getAiConversation(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<AiConversationDetailView> {
  const { data } = await client.request<AiConversationDetailView>({
    path: `${base(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}`,
  });
  return data;
}

export async function deleteAiConversation(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}`,
  });
}

/** Why TManage AI cannot answer in this workspace (the API's `ai_unavailable` reason). */
export type AiUnavailableReason = 'not_on_test_list' | 'flag_off' | 'ai_off' | 'no_key';

const AI_UNAVAILABLE_REASONS: readonly AiUnavailableReason[] = [
  'not_on_test_list',
  'flag_off',
  'ai_off',
  'no_key',
];

/**
 * AI-TWO-WAYS: the reason of a 404 `ai_unavailable`, or `null` for any other failure. An unknown
 * reason from a newer API reads as `not_on_test_list` (the plain "not available yet").
 */
export function aiUnavailableReason(error: unknown): AiUnavailableReason | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'ai_unavailable') return null;
  const reason = error.fieldErrors().get('reason');
  return AI_UNAVAILABLE_REASONS.find((known) => known === reason) ?? 'not_on_test_list';
}
