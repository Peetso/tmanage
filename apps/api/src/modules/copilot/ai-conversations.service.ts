import { uuidv7 } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  AiConversationsRepository,
  type AiConversationMessageRow,
  type AiConversationRow,
} from './ai-conversations.repository.js';
import { openStanding, type ChatStanding } from './copilot-chat.service.js';

/**
 * 62-13 (plan 62 §9 row: "Conversations: store, list, delete, private to the member; retention
 * setting (default 30 days) and purge").
 *
 * - **Private to the member.** Every read and delete is bound to the caller's own organization and
 *   membership (the repository's statements); another member's or another workspace's conversation
 *   is 404, never 403, so its existence does not leak. No owner or admin route reads them.
 * - **Delete really deletes**: the messages, then the conversation, in one transaction; nothing is
 *   kept (the `ai_tasks` receipt of a turn never held text).
 * - **Retention**: the owner (`org.manage`) sets 1 to 365 days, default
 *   {@link AI_CONVERSATION_DEFAULT_RETENTION_DAYS}; the worker's `ai-conversation-purge` deletes a
 *   conversation once its last message is older. The change is audited
 *   (`ai_conversation.retention_updated`, the days only).
 * - **The chat's port** ({@link ChatConversations}): a turn sent with a `conversationId` gets the
 *   last {@link AI_CONVERSATION_HISTORY_MESSAGES} messages as history, and an answered turn is
 *   recorded (the member's message and the guarded answer the member saw).
 *
 * Every route shares the chat's gates (`openStanding`: a member on an ordinary session, the
 * workspace on the test list, the `copilot` flag on).
 */

export const AI_CONVERSATION_DEFAULT_RETENTION_DAYS = 30;
export const AI_CONVERSATION_RETENTION_MIN_DAYS = 1;
export const AI_CONVERSATION_RETENTION_MAX_DAYS = 365;
export const AI_CONVERSATION_TITLE_MAX_CHARS = 120;
/** The messages (member and assistant) a new turn is given as history. */
export const AI_CONVERSATION_HISTORY_MESSAGES = 10;
export const AI_CONVERSATION_LIST_LIMIT = 50;
export const AI_CONVERSATION_MESSAGES_LIMIT = 500;
export const AI_CONVERSATION_RETENTION_AUDIT_ACTION = 'ai_conversation.retention_updated';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One conversation in the member's list. No web client yet (62-15). */
export interface AiConversationView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
}

/** `GET …/copilot/conversations`. No web client yet (62-15). */
export interface AiConversationListView {
  readonly items: readonly AiConversationView[];
  readonly retentionDays: number;
}

/** One message of a conversation. No web client yet (62-15). */
export interface AiConversationMessageView {
  readonly id: string;
  readonly role: 'member' | 'assistant';
  readonly body: string;
  readonly taskId: string | null;
  readonly createdAt: string;
}

/** `GET …/copilot/conversations/:conversationId`. No web client yet (62-15). */
export interface AiConversationDetailView {
  readonly conversation: AiConversationView;
  readonly messages: readonly AiConversationMessageView[];
}

/** `PUT …/copilot/conversation-retention`. No web client yet (62-15). */
export interface AiConversationRetentionView {
  readonly retentionDays: number;
}

/** The history a turn is given: oldest first. */
export interface ChatHistoryMessage {
  readonly role: 'member' | 'assistant';
  readonly body: string;
}

/** What the chat needs of the conversations (a port, faked by the chat's unit tests). */
export interface ChatConversations {
  /** The last messages of the member's own conversation; `null` when it is not theirs. */
  history(
    context: TenantContext,
    conversationId: string,
  ): Promise<readonly ChatHistoryMessage[] | null>;
  /**
   * Records one answered turn: a new conversation when `conversationId` is `null` (or the one sent
   * was deleted or purged meanwhile). Returns the conversation the turn is in.
   */
  record(
    context: TenantContext,
    turn: {
      readonly conversationId: string | null;
      readonly message: string;
      readonly answer: string;
      readonly taskId: string;
      readonly askedAt: Date;
    },
  ): Promise<string>;
}

export interface AiConversationsDeps {
  readonly database: TenantDatabase;
  readonly standing: (context: TenantContext) => Promise<ChatStanding>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository?: AiConversationsRepository;
  readonly now?: () => Date;
}

const notFound = (auditCode: string) =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);

/** A conversation id from a path or body; anything else is "not found" (no oracle). */
export function conversationIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    throw notFound('ai_conversation:bad_id');
  }
  return raw.toLowerCase();
}

/** The retention body, parsed at the boundary (IP-2). */
export function parseRetentionBody(body: Readonly<Record<string, unknown>> | null): number {
  const days = body?.['retentionDays'];
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < AI_CONVERSATION_RETENTION_MIN_DAYS ||
    days > AI_CONVERSATION_RETENTION_MAX_DAYS
  ) {
    throw new ApiError(400, 'validation_failed', 'Choose how many days to keep conversations.', [
      {
        field: 'retentionDays',
        message: `a whole number from ${String(AI_CONVERSATION_RETENTION_MIN_DAYS)} to ${String(AI_CONVERSATION_RETENTION_MAX_DAYS)}`,
      },
    ]);
  }
  return days;
}

/** The title of a new conversation: the start of its first message, on one line. */
export function conversationTitle(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return [...line].slice(0, AI_CONVERSATION_TITLE_MAX_CHARS).join('');
}

const conversationView = (row: AiConversationRow): AiConversationView => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
});

const messageView = (row: AiConversationMessageRow): AiConversationMessageView => ({
  id: row.id,
  role: row.role,
  body: row.body,
  taskId: row.taskId,
  createdAt: row.createdAt.toISOString(),
});

export class AiConversationsService implements ChatConversations {
  private readonly repository: AiConversationsRepository;

  private readonly now: () => Date;

  constructor(private readonly deps: AiConversationsDeps) {
    this.repository = deps.repository ?? new AiConversationsRepository();
    this.now = deps.now ?? (() => new Date());
  }

  async list(context: TenantContext): Promise<AiConversationListView> {
    await openStanding(context, this.deps.standing);
    return this.deps.database.read(context, async (runner) => ({
      items: (await this.repository.list(runner, context, AI_CONVERSATION_LIST_LIMIT)).map(
        conversationView,
      ),
      retentionDays:
        (await this.repository.retention(runner, context)) ??
        AI_CONVERSATION_DEFAULT_RETENTION_DAYS,
    }));
  }

  async get(context: TenantContext, rawId: unknown): Promise<AiConversationDetailView> {
    await openStanding(context, this.deps.standing);
    const id = conversationIdOf(rawId);
    return this.deps.database.read(context, async (runner) => {
      const conversation = await this.repository.one(runner, context, id);
      if (conversation === null) throw notFound('ai_conversation:not_own');
      const messages = await this.repository.messages(
        runner,
        context,
        id,
        AI_CONVERSATION_MESSAGES_LIMIT,
      );
      return { conversation: conversationView(conversation), messages: messages.map(messageView) };
    });
  }

  /** Deletes the member's own conversation and every message of it; 404 for anyone else's. */
  async delete(context: TenantContext, rawId: unknown): Promise<void> {
    await openStanding(context, this.deps.standing);
    const id = conversationIdOf(rawId);
    const deleted = await this.deps.database.transaction(context, (tx) =>
      this.repository.delete(tx, context, id),
    );
    if (!deleted) throw notFound('ai_conversation:not_own');
  }

  async setRetention(context: TenantContext, days: number): Promise<AiConversationRetentionView> {
    await openStanding(context, this.deps.standing);
    const at = this.now();
    await this.deps.database.transaction(context, async (tx) => {
      const before = await this.repository.retention(tx, context);
      await this.repository.setRetention(tx, context, { id: uuidv7(), days, at });
      await this.deps.audit.record(tx, context, {
        action: AI_CONVERSATION_RETENTION_AUDIT_ACTION,
        result: 'allowed',
        objectId: context.organizationId,
        actorUserId: context.userId,
        metadata: {
          before_days: before ?? AI_CONVERSATION_DEFAULT_RETENTION_DAYS,
          after_days: days,
        },
      });
    });
    return { retentionDays: days };
  }

  async history(
    context: TenantContext,
    rawId: string,
  ): Promise<readonly ChatHistoryMessage[] | null> {
    const id = conversationIdOf(rawId);
    return this.deps.database.read(context, async (runner) => {
      if ((await this.repository.one(runner, context, id)) === null) return null;
      const rows = await this.repository.recent(
        runner,
        context,
        id,
        AI_CONVERSATION_HISTORY_MESSAGES,
      );
      // The history starts with a member message (a cut pair at the window's edge is dropped).
      const start = rows.findIndex((row) => row.role === 'member');
      return (start < 0 ? [] : rows.slice(start)).map((row) => ({
        role: row.role,
        body: row.body,
      }));
    });
  }

  async record(
    context: TenantContext,
    turn: Parameters<ChatConversations['record']>[1],
  ): Promise<string> {
    const answeredAt = new Date(Math.max(this.now().getTime(), turn.askedAt.getTime() + 1));
    return this.deps.database.transaction(context, async (tx) => {
      let conversationId = turn.conversationId;
      // A conversation deleted or purged while the turn ran: the turn starts a new one.
      if (
        conversationId === null ||
        !(await this.repository.touch(tx, context, conversationId, answeredAt))
      ) {
        conversationId = uuidv7();
        await this.repository.insertConversation(tx, context, {
          id: conversationId,
          title: conversationTitle(turn.message),
          at: answeredAt,
        });
      }
      await this.repository.insertMessage(tx, context, conversationId, {
        id: uuidv7(),
        role: 'member',
        body: turn.message,
        taskId: null,
        createdAt: turn.askedAt,
      });
      await this.repository.insertMessage(tx, context, conversationId, {
        id: uuidv7(),
        role: 'assistant',
        body: turn.answer,
        taskId: turn.taskId,
        createdAt: answeredAt,
      });
      return conversationId;
    });
  }
}
