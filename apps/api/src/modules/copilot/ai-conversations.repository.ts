import type { ResultSetHeader } from 'mysql2';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 62-13 (plan 62 §9 row) — every statement on the in-app AI's conversations (`ai_conversations`,
 * `ai_conversation_messages`, 0392) and the owner's retention (`ai_workspace_settings`
 * `conversation_retention_days`).
 *
 * A conversation is private to the member who had it: every statement names the organization AND
 * the member's own `membership_id`, both bound from the context (DA-12), so another member (an owner
 * or admin included) and another workspace read nothing and delete nothing. A message is reached
 * only through its conversation's member. Times are bound values, never the database clock (DA-10).
 */

export type AiConversationRole = 'member' | 'assistant';

export interface AiConversationRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
}

export interface AiConversationMessageRow {
  readonly id: string;
  readonly role: AiConversationRole;
  readonly body: string;
  readonly taskId: string | null;
  readonly createdAt: Date;
}

export interface NewAiMessage {
  readonly id: string;
  readonly role: AiConversationRole;
  readonly body: string;
  readonly taskId: string | null;
  readonly createdAt: Date;
}

export const AI_CONVERSATIONS_SQL = {
  list: `select id, title, created_at, last_message_at from ai_conversations
    where organization_id = ? and membership_id = ?
    order by last_message_at desc, id desc limit ?`,
  one: `select id, title, created_at, last_message_at from ai_conversations
    where organization_id = ? and id = ? and membership_id = ? limit 1`,
  messages: `select id, role, body, task_id, created_at from ai_conversation_messages
    where organization_id = ? and conversation_id = ? and membership_id = ?
    order by created_at, id limit ?`,
  recent: `select id, role, body, task_id, created_at from ai_conversation_messages
    where organization_id = ? and conversation_id = ? and membership_id = ?
    order by created_at desc, id desc limit ?`,
  insertConversation: `insert into ai_conversations
    (id, organization_id, membership_id, title, created_at, last_message_at)
    values (?, ?, ?, ?, ?, ?)`,
  insertMessage: `insert into ai_conversation_messages
    (id, organization_id, conversation_id, membership_id, role, body, task_id, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
  touch: `update ai_conversations set last_message_at = ?
    where organization_id = ? and id = ? and membership_id = ?`,
  deleteMessages: `delete from ai_conversation_messages
    where organization_id = ? and conversation_id = ? and membership_id = ?`,
  deleteConversation: `delete from ai_conversations
    where organization_id = ? and id = ? and membership_id = ?`,
  retention: `select conversation_retention_days from ai_workspace_settings
    where organization_id = ? limit 1`,
  upsertRetention: `insert into ai_workspace_settings
    (id, organization_id, ai_enabled, write_scope, run_at_once, member_share_percent, test_list_at,
     pool_class, conversation_retention_days, updated_by_membership_id, created_at, updated_at)
    values (?, ?, 0, 'read', 0, 50, null, 'customers', ?, ?, ?, ?)
    on duplicate key update conversation_retention_days = values(conversation_retention_days),
      updated_by_membership_id = values(updated_by_membership_id), updated_at = values(updated_at)`,
} as const;

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

function conversationOf(row: Readonly<Record<string, unknown>>): AiConversationRow {
  return {
    id: String(row['id']),
    title: String(row['title']),
    createdAt: asDate(row['created_at']),
    lastMessageAt: asDate(row['last_message_at']),
  };
}

function messageOf(row: Readonly<Record<string, unknown>>): AiConversationMessageRow {
  return {
    id: String(row['id']),
    role: row['role'] === 'assistant' ? 'assistant' : 'member',
    body: String(row['body']),
    taskId: typeof row['task_id'] === 'string' ? row['task_id'] : null,
    createdAt: asDate(row['created_at']),
  };
}

export class AiConversationsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<readonly AiConversationRow[]> {
    const rows = await runner.execute<QueryRows>(AI_CONVERSATIONS_SQL.list, [
      context.organizationId,
      context.membershipId,
      limit,
    ]);
    return rows.map(conversationOf);
  }

  async one(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<AiConversationRow | null> {
    const rows = await runner.execute<QueryRows>(AI_CONVERSATIONS_SQL.one, [
      context.organizationId,
      conversationId,
      context.membershipId,
    ]);
    return rows[0] === undefined ? null : conversationOf(rows[0]);
  }

  /** The conversation's messages, oldest first. */
  async messages(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly AiConversationMessageRow[]> {
    const rows = await runner.execute<QueryRows>(AI_CONVERSATIONS_SQL.messages, [
      context.organizationId,
      conversationId,
      context.membershipId,
      limit,
    ]);
    return rows.map(messageOf);
  }

  /** The last `limit` messages, oldest first (the history a new turn is given). */
  async recent(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly AiConversationMessageRow[]> {
    const rows = await runner.execute<QueryRows>(AI_CONVERSATIONS_SQL.recent, [
      context.organizationId,
      conversationId,
      context.membershipId,
      limit,
    ]);
    return rows.map(messageOf).reverse();
  }

  async insertConversation(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly id: string; readonly title: string; readonly at: Date },
  ): Promise<void> {
    await runner.execute<ResultSetHeader>(AI_CONVERSATIONS_SQL.insertConversation, [
      input.id,
      context.organizationId,
      context.membershipId,
      input.title,
      input.at,
      input.at,
    ]);
  }

  async insertMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    message: NewAiMessage,
  ): Promise<void> {
    await runner.execute<ResultSetHeader>(AI_CONVERSATIONS_SQL.insertMessage, [
      message.id,
      context.organizationId,
      conversationId,
      context.membershipId,
      message.role,
      message.body,
      message.taskId,
      message.createdAt,
    ]);
  }

  /** Moves `last_message_at`; `false` when the conversation is gone (deleted or purged). */
  async touch(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    at: Date,
  ): Promise<boolean> {
    const result = await runner.execute<ResultSetHeader>(AI_CONVERSATIONS_SQL.touch, [
      at,
      context.organizationId,
      conversationId,
      context.membershipId,
    ]);
    return result.affectedRows === 1;
  }

  /** Deletes the member's conversation and its messages; `false` when it was not theirs. */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<boolean> {
    const binds = [context.organizationId, conversationId, context.membershipId];
    await runner.execute<ResultSetHeader>(AI_CONVERSATIONS_SQL.deleteMessages, binds);
    const result = await runner.execute<ResultSetHeader>(
      AI_CONVERSATIONS_SQL.deleteConversation,
      binds,
    );
    return result.affectedRows === 1;
  }

  /** The workspace's retention in days, or `null` when it has no settings row (the default). */
  async retention(runner: TenantQueryRunner, context: TenantContext): Promise<number | null> {
    const rows = await runner.execute<QueryRows>(AI_CONVERSATIONS_SQL.retention, [
      context.organizationId,
    ]);
    const value = rows[0]?.['conversation_retention_days'];
    return value === undefined || value === null ? null : Number(value);
  }

  async setRetention(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly id: string; readonly days: number; readonly at: Date },
  ): Promise<void> {
    await runner.execute<ResultSetHeader>(AI_CONVERSATIONS_SQL.upsertRetention, [
      input.id,
      context.organizationId,
      input.days,
      context.membershipId,
      input.at,
      input.at,
    ]);
  }
}
