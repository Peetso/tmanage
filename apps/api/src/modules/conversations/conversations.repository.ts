import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { RichTextDocument } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import {
  conversationMemberships,
  conversations,
  messageRevisions,
  messages,
  messageWorkLinks,
} from '../../common/database/schema.js';
import type {
  ConversationMembershipRow,
  ConversationRow,
  MessageRevisionRow,
  MessageRow,
  MessageWorkLinkRow,
} from '../../common/database/schema.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Conversations, their members and their messages — CHAT-001's storage half.
 *
 * `WorkItemsRepository`'s shape: `TenantContext` as the scoping parameter, no `organizationId`
 * on any input type, keyset pagination, not-found rather than conflict for a caller in the
 * wrong tenant. Three things are specific to this aggregate.
 *
 * ## 1. The sequence number is allocated, never supplied
 *
 * `23-ERD-AND-STATE-MACHINES` §4 requires `(organization_id, conversation_id, sequence_no)` to
 * be unique and `27-TEST-CATALOG` INT-08 requires it to be monotonic per conversation.
 * {@link ConversationsRepository.appendMessage} takes the conversation row's lock with
 * `SELECT ... FOR UPDATE`, writes the `next_sequence_no` it read, and increments it — all
 * inside the caller's transaction, so two authors posting at once serialise on that row rather
 * than racing.
 *
 * `MAX(sequence_no) + 1` is the obvious alternative and it is wrong: between the read and the
 * insert another session can do the same, and the row it would have to lock to prevent that is
 * the row it is about to create. The unique key is the backstop either way, but with the
 * counter it is a backstop rather than the mechanism.
 *
 * There is deliberately **no `sequenceNo` field** on {@link AppendMessageInput}. A caller
 * cannot supply one, so there is no path that numbers a message by hand.
 *
 * ## 2. A reply names a parent, and the engine decides whether it may
 *
 * `depth` and `parentDepth` are written here and are not a caller's to choose. Their only
 * purpose is to let `fk_messages_parent_is_root` refuse a reply whose parent is itself a
 * reply — see `0007_conversations.sql`. This file writes `depth = 1, parentDepth = 0` for a
 * reply and `depth = 0, parentDepth = null` for a root, and then lets InnoDB decide. It does
 * **not** first read the parent to check its depth: a read-then-write check is a race, and the
 * foreign key is not.
 *
 * ## 3. Nothing here deletes a message
 *
 * `12-PERMISSION-MATRIX` §2 has "Moderate messages", so a message can be taken down —
 * {@link ConversationsRepository.moderateMessage} sets `deleted_at` and `deleted_by_user_id`.
 * `users.sql` grants no DELETE on `messages`, so the absence of a hard delete is structural
 * rather than this file's restraint: a removal that leaves no trace is erasure, not moderation.
 */

export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    // No organization id in the message, for the reason `WorkItemNotFoundError` gives: a
    // caller probing for another tenant's channel must learn nothing from the wording.
    super(`Conversation ${conversationId} was not found`);
    this.name = 'ConversationNotFoundError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`Message ${messageId} was not found`);
    this.name = 'MessageNotFoundError';
  }
}

export class ConversationVersionConflictError extends Error {
  constructor(
    readonly conversationId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Conversation ${conversationId} was modified concurrently ` +
        `(expected version ${expectedVersion})`,
    );
    this.name = 'ConversationVersionConflictError';
  }
}

/**
 * A name already in use on this project. Distinct from a version conflict.
 *
 * The field is `conversationName` rather than `name`: `Error.name` is the class name and
 * TypeScript refuses to shadow it without `override`. Overriding it would have made
 * `error.name` the channel's name, which every `catch` in this codebase reads as the error's
 * kind.
 */
export class ConversationNameTakenError extends Error {
  constructor(readonly conversationName: string) {
    super(`This project already has a channel called ${conversationName}`);
    this.name = 'ConversationNameTakenError';
  }
}

/**
 * A reply whose parent is itself a reply, refused by `fk_messages_parent_is_root`.
 *
 * Raised by translating the driver's foreign-key error rather than by a prior read, because
 * the engine's answer is the one that is not a race. It carries the same meaning as "there is
 * no such parent in this conversation", and the service reports it as one message for both:
 * a caller must not be able to tell "that message exists but is a reply" from "that message
 * does not exist", which would let them probe a channel they cannot read.
 */
export class InvalidThreadParentError extends Error {
  constructor(readonly parentMessageId: string) {
    super(`Message ${parentMessageId} cannot be replied to`);
    this.name = 'InvalidThreadParentError';
  }
}

/** A second message with the same client-generated id from the same author. */
export class DuplicateMessageError extends Error {
  constructor(readonly clientGeneratedId: string) {
    super(`A message with client id ${clientGeneratedId} already exists`);
    this.name = 'DuplicateMessageError';
  }
}

/**
 * A second conversion of the same message, refused by `uq_message_work_links_message`.
 *
 * Raised from the engine's duplicate-key answer rather than from a prior read, because the
 * read-then-insert gap is exactly the race INT-07 is about. The caller's transaction — and
 * with it the second work item that transaction created — rolls back; the service then
 * hands back the conversion that already exists.
 */
export class MessageAlreadyConvertedError extends Error {
  constructor(readonly messageId: string) {
    super(`Message ${messageId} has already been converted to work`);
    this.name = 'MessageAlreadyConvertedError';
  }
}

export interface CreateConversationInput {
  readonly projectId: string;
  readonly name: string;
  readonly createdByUserId: string;
}

export interface ListConversationsOptions {
  readonly projectId?: string;
  /** Keyset pagination. Cursors are ids, and the sort is by id. */
  readonly after?: string;
  readonly limit?: number;
  /** Archived channels are excluded unless this is true. */
  readonly includeArchived?: boolean;
}

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly body: string;
  /**
   * The sanitised rich-text document, or null for a plain-text message. Sanitised is a
   * precondition rather than a courtesy this layer performs: the only caller is the service,
   * which builds this field from `sanitizeRichText`'s return value — CHAT-002's write
   * boundary — with `body` derived from the same document.
   */
  readonly bodyRich?: RichTextDocument | null;
  /** A root message when absent; a reply to that message when present. */
  readonly parentMessageId?: string | null;
  /** `23-ERD` §4's retry dedupe. Optional, and absent means no protection. */
  readonly clientGeneratedId?: string | null;
}

export interface ListMessagesOptions {
  /**
   * Keyset pagination **by sequence number**, not by id. The sequence is the conversation's
   * own order and is what a reader scrolls through; paging by id would be a second ordering
   * that agrees with the first only because both are monotonic today.
   */
  readonly afterSequenceNo?: number;
  readonly limit?: number;
  /**
   * `null` returns only top-level messages — the channel view. A message id returns that
   * message's replies — TM-08's thread pane. Omitted returns both, which is what a search or
   * an export wants and what a channel view must not use.
   */
  readonly parentMessageId?: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';
/** MySQL's foreign-key failure on insert. */
const ER_NO_REFERENCED_ROW = 'ER_NO_REFERENCED_ROW_2';

/**
 * The driver's own error code, **unwrapped first**.
 *
 * Not defensive coding: Drizzle wraps anything thrown during execution in a
 * `DrizzleQueryError`, which carries no `code` of its own and keeps the driver's error on
 * `cause`, and `TenantDatabase` strips that wrapper only at the transaction boundary.
 * Everything in this file reacts to a driver error *inside* the transaction, before that
 * boundary is reached. `OrganizationsRepository` records the same
 * trap and the same fix; this file's first run reproduced it exactly — a duplicate channel
 * name reached the controller as a 500 instead of a 409.
 *
 * **The string `code` is the whole test**, and the numeric `errno` is not consulted. mysql2
 * builds every server error in `Packet.asError`, which is the only place in the driver that
 * assigns `errno` at all and which sets `code` from its `ErrorCodeToName` table in the
 * statement immediately before. Both 1062 and 1452 have names in that table, and
 * `unwrapQueryError` returns that same error object — it removes `sql` and nothing else — so
 * an error reaching here with one of those numbers always carries the matching name too.
 */
function driverErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  const candidate = unwrapped as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

/** The index a duplicate-key error names, so two unique keys are not conflated. */
function violatedIndex(error: unknown): string | undefined {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  const candidate = unwrapped as { sqlMessage?: unknown; message?: unknown };
  const text =
    typeof candidate.sqlMessage === 'string'
      ? candidate.sqlMessage
      : typeof candidate.message === 'string'
        ? candidate.message
        : '';
  const match = /for key '(?:[^.']+\.)?([^']+)'/.exec(text);
  return match?.[1];
}

export class ConversationsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListConversationsOptions = {},
  ): Promise<readonly ConversationRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(conversations.organizationId, context.organizationId)];
    if (options.projectId) predicates.push(eq(conversations.projectId, options.projectId));
    if (!options.includeArchived) predicates.push(isNull(conversations.archivedAt));
    if (options.after) predicates.push(gt(conversations.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(and(...predicates))
      .orderBy(asc(conversations.id))
      .limit(limit);
  }

  /**
   * Fetch one conversation by id, within the acting tenant.
   *
   * There is deliberately no `findById(id)` without a context, for the reason ADR-0001 exists:
   * on MySQL such a method returns another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<ConversationRow> {
    const found = await this.findById(runner, context, conversationId);
    if (!found) throw new ConversationNotFoundError(conversationId);
    return found;
  }

  /**
   * Create a channel on a project.
   *
   * The project is not re-checked here: `fk_conversations_project_tenant` is composite and
   * includes `organization_id`, so the database refuses a channel naming another tenant's
   * project. What the service checks, and the database cannot, is whether the acting principal
   * is related to that project.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateConversationInput,
  ): Promise<ConversationRow> {
    const id = uuidv7();

    try {
      await tenantDrizzle(runner)
        .insert(conversations)
        .values({
          id,
          // From the context. Not from `input` — there is no such field.
          organizationId: context.organizationId,
          projectId: input.projectId,
          name: input.name,
          createdByUserId: input.createdByUserId,
          version: 1,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        throw new ConversationNameTakenError(input.name);
      }
      throw error;
    }

    return this.requireById(runner, context, id);
  }

  /**
   * Rename a channel, against the version the caller read.
   *
   * The `WHERE` names the version, so a second writer's update matches no row and the caller
   * is told rather than silently overwriting. `next_sequence_no` is untouched — appending a
   * message is not a change to the channel and does not move `version`.
   */
  async rename(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    expectedVersion: number,
    name: string,
  ): Promise<ConversationRow> {
    let result;
    try {
      result = await tenantDrizzle(runner)
        .update(conversations)
        .set({ name, version: sql`${conversations.version} + 1` })
        .where(
          and(
            eq(conversations.organizationId, context.organizationId),
            eq(conversations.id, conversationId),
            eq(conversations.version, expectedVersion),
          ),
        );
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) throw new ConversationNameTakenError(name);
      throw error;
    }

    if (result[0].affectedRows === 0) {
      // Either it does not exist in this tenant, or the version moved. Distinguishing the two
      // needs a read, and that read is what tells the caller which of the two it was.
      await this.requireById(runner, context, conversationId);
      throw new ConversationVersionConflictError(conversationId, expectedVersion);
    }

    return this.requireById(runner, context, conversationId);
  }

  async archive(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    expectedVersion: number,
  ): Promise<ConversationRow> {
    const result = await tenantDrizzle(runner)
      .update(conversations)
      .set({ archivedAt: new Date(), version: sql`${conversations.version} + 1` })
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.id, conversationId),
          eq(conversations.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      await this.requireById(runner, context, conversationId);
      throw new ConversationVersionConflictError(conversationId, expectedVersion);
    }

    return this.requireById(runner, context, conversationId);
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  async listMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<readonly ConversationMembershipRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
        ),
      )
      .orderBy(asc(conversationMemberships.id));
  }

  async findMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    userId: string,
  ): Promise<ConversationMembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
          eq(conversationMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Add somebody to a channel. Idempotent by identity: adding a member twice returns the
   * membership that already exists rather than failing, because "make sure this person is in
   * the room" is the operation a caller actually wants and a duplicate is not an error worth
   * making them handle.
   */
  async addMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    userId: string,
  ): Promise<ConversationMembershipRow> {
    const existing = await this.findMembership(runner, context, conversationId, userId);
    if (existing) return existing;

    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(conversationMemberships)
        .values({
          id,
          organizationId: context.organizationId,
          conversationId,
          userId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      // Lost the race with a concurrent add. The unique key held, which is the point of
      // having it; the caller still gets the row they asked for.
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        const raced = await this.findMembership(runner, context, conversationId, userId);
        if (raced) return raced;
      }
      throw error;
    }

    const created = await this.findMembership(runner, context, conversationId, userId);
    if (!created) throw new ConversationNotFoundError(conversationId);
    return created;
  }

  /** Returns whether a row was removed, so the caller can tell a no-op from a revocation. */
  async removeMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
          eq(conversationMemberships.userId, userId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async listMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<readonly MessageRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [
      eq(messages.organizationId, context.organizationId),
      eq(messages.conversationId, conversationId),
    ];
    if (options.parentMessageId === null) {
      predicates.push(isNull(messages.parentMessageId));
    } else if (options.parentMessageId !== undefined) {
      predicates.push(eq(messages.parentMessageId, options.parentMessageId));
    }
    if (options.afterSequenceNo !== undefined) {
      predicates.push(gt(messages.sequenceNo, options.afterSequenceNo));
    }

    return tenantDrizzle(runner)
      .select()
      .from(messages)
      .where(and(...predicates))
      .orderBy(asc(messages.sequenceNo))
      .limit(limit);
  }

  async findMessageById(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<MessageRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messages)
      .where(and(eq(messages.organizationId, context.organizationId), eq(messages.id, messageId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireMessageById(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<MessageRow> {
    const found = await this.findMessageById(runner, context, messageId);
    if (!found) throw new MessageNotFoundError(messageId);
    return found;
  }

  /**
   * Append a message, allocating its sequence number under the conversation's row lock.
   *
   * **Must be called inside a transaction.** `SELECT ... FOR UPDATE` on a connection with
   * autocommit on takes a lock and releases it immediately, which would make the allocation
   * exactly the race it exists to prevent. `ConversationsService` never calls this outside
   * `TenantDatabase.transaction()`, and the database suite proves the numbering holds under
   * concurrent appends rather than asserting that it does.
   */
  async appendMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendMessageInput,
  ): Promise<MessageRow> {
    // The allocator. Drizzle's proxy dialect has no `.for('update')`, and the lock is the
    // point of the statement, so it is written out.
    const locked = await runner.execute<QueryRows>(
      `select next_sequence_no from conversations
        where organization_id = ? and id = ?
        for update`,
      [context.organizationId, input.conversationId],
    );
    const sequenceNo = locked[0]?.['next_sequence_no'] as number | undefined;
    if (sequenceNo === undefined) throw new ConversationNotFoundError(input.conversationId);

    await runner.execute(
      `update conversations set next_sequence_no = next_sequence_no + 1
        where organization_id = ? and id = ?`,
      [context.organizationId, input.conversationId],
    );

    const id = uuidv7();
    const parentMessageId = input.parentMessageId ?? null;

    try {
      await tenantDrizzle(runner)
        .insert(messages)
        .values({
          id,
          organizationId: context.organizationId,
          conversationId: input.conversationId,
          authorUserId: input.authorUserId,
          sequenceNo: Number(sequenceNo),
          parentMessageId,
          // Written here, never by a caller. See the note at the top of this file.
          depth: parentMessageId === null ? 0 : 1,
          parentDepth: parentMessageId === null ? null : 0,
          body: input.body,
          bodyRich: input.bodyRich ?? null,
          clientGeneratedId: input.clientGeneratedId ?? null,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      const code = driverErrorCode(error);
      if (code === ER_NO_REFERENCED_ROW && parentMessageId !== null) {
        // `fk_messages_parent_is_root`: either there is no such message in this tenant, or
        // there is and it is itself a reply. Both are "you cannot reply to that".
        throw new InvalidThreadParentError(parentMessageId);
      }
      if (code === ER_DUP_ENTRY && violatedIndex(error) === 'uq_messages_client_generated') {
        throw new DuplicateMessageError(input.clientGeneratedId ?? '');
      }
      throw error;
    }

    return this.requireMessageById(runner, context, id);
  }

  /**
   * Find a message this author already sent under the same client-generated id **in this
   * conversation**.
   *
   * The dedupe read, run before {@link appendMessage} so an honest retry returns the original
   * message rather than an error. The unique key is what actually guarantees it; this only
   * decides whether the caller sees a 201 or the message they already sent.
   *
   * The `conversationId` predicate is load-bearing, not decorative. `uq_messages_client_generated`
   * is `(organization_id, author_user_id, client_generated_id)` and does **not** include the
   * conversation, so an author's key is unique across every channel they can write to. Without
   * this predicate a caller could replay a key from a message they posted to one channel — even
   * one they have since lost access to — through a different channel and read the old body back.
   * Scoping the read to the destination means a key that belongs to another conversation misses
   * here, falls through to {@link appendMessage}, and collides with the unique key there, which
   * the caller sees as a 409 rather than as a silent hit against the wrong room.
   */
  async findByClientGeneratedId(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    authorUserId: string,
    clientGeneratedId: string,
  ): Promise<MessageRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, conversationId),
          eq(messages.authorUserId, authorUserId),
          eq(messages.clientGeneratedId, clientGeneratedId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Edit a message's body.
   *
   * Neither `edited_at` nor the history row is written here, and that is the point:
   * `trg_messages_record_revision` (`0008_message_rich_text.sql`) forces `edited_at` forward
   * and archives the displaced body whenever either body column changes, for *any* session —
   * so there is no path, in this file or outside it, that changes what somebody said without
   * recording that it changed and what it changed from. The trigger in
   * `0007_conversations.sql` still refuses every identity column, so an "edit" cannot
   * quietly move or reattribute a message.
   *
   * `bodyRich` is written even when null: a plain-text edit of a rich message replaces the
   * document, and leaving the old markup beside the new text would be two bodies free to
   * disagree.
   */
  async editMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    body: string,
    bodyRich: RichTextDocument | null,
  ): Promise<MessageRow> {
    const result = await tenantDrizzle(runner)
      .update(messages)
      .set({ body, bodyRich })
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.id, messageId),
          // A deleted message is not editable. Editing one would let a moderated message be
          // rewritten and left in place with its removal still recorded.
          isNull(messages.deletedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      await this.requireMessageById(runner, context, messageId);
      throw new MessageNotFoundError(messageId);
    }
    return this.requireMessageById(runner, context, messageId);
  }

  /**
   * A message's edit history, oldest first — the bodies it had before each change, written
   * by the engine rather than read back from anything this application promised to do. The
   * current body is on the message row; the service is what decides whether a moderated
   * message's history may still be read out.
   */
  async listRevisions(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<readonly MessageRevisionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(messageRevisions)
      .where(
        and(
          eq(messageRevisions.organizationId, context.organizationId),
          eq(messageRevisions.messageId, messageId),
        ),
      )
      .orderBy(asc(messageRevisions.revisionNo));
  }

  /** The conversion this message already has, or null. The read half of INT-07's retry. */
  async findWorkLinkByMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<MessageWorkLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messageWorkLinks)
      .where(
        and(
          eq(messageWorkLinks.organizationId, context.organizationId),
          eq(messageWorkLinks.messageId, messageId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record that a message became a work item. **Must run in the same transaction that
   * creates the work item**: the unique key on the message is what makes the pair atomic —
   * a lost race rolls both back together, which is INT-07's "one linked work item" holding
   * under concurrency rather than being asserted about a single caller.
   */
  async createWorkLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    workItemId: string,
    createdByUserId: string,
  ): Promise<MessageWorkLinkRow> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(messageWorkLinks)
        .values({
          id,
          organizationId: context.organizationId,
          messageId,
          workItemId,
          createdByUserId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        throw new MessageAlreadyConvertedError(messageId);
      }
      throw error;
    }

    const rows = await tenantDrizzle(runner)
      .select()
      .from(messageWorkLinks)
      .where(
        and(
          eq(messageWorkLinks.organizationId, context.organizationId),
          eq(messageWorkLinks.id, id),
        ),
      )
      .limit(1);
    const created = rows[0];
    if (!created) throw new MessageNotFoundError(messageId);
    return created;
  }

  /**
   * Take a message down. The row survives; `users.sql` grants no DELETE here.
   *
   * Idempotent: moderating an already-moderated message leaves the original moderator and
   * timestamp in place, because the first removal is the one that happened.
   */
  async moderateMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    deletedByUserId: string,
  ): Promise<MessageRow> {
    await this.requireMessageById(runner, context, messageId);

    await tenantDrizzle(runner)
      .update(messages)
      .set({ deletedAt: new Date(), deletedByUserId })
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.id, messageId),
          isNull(messages.deletedAt),
        ),
      );

    return this.requireMessageById(runner, context, messageId);
  }
}
