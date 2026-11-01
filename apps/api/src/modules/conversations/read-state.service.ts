import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ConversationRow } from '../../common/database/schema.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { ConversationReadStateRepository, ReadStateReader } from './read-state.repository.js';
import { deriveReceipts, MessageReceiptsRepository } from './message-receipts.repository.js';
import type { MessageReceiptsView } from './message-receipts.repository.js';

/**
 * Conversation read-state — the caller's own last-read position per channel and the unread count
 * computed from it (module CHAT, CH-05 "unread position", x250).
 *
 * ## Own position only, and the capability reused rather than invented
 *
 * The subject is always the authenticated `principal`'s membership; no path or body field names
 * another member's position, so a caller reads and advances their own row and no other. The
 * capability is **`conversation.read`** — the read gate the rest of the aggregate uses. A read
 * position is a read, not a message; advancing it needs no write capability, and pass-24 forbids
 * inventing a new capability in `capabilities.ts`.
 *
 * ## The gate: resolve, then authorize, and the order is the whole of the rule
 *
 * Every entry resolves the conversation (and, for a mark-read, the message) tenant-scoped **before**
 * authorizing, so a caller with no relation to the channel gets a 404 that reveals nothing — a
 * channel's existence is itself information (`ConversationsService`'s reasoning). `mayReach` then
 * applies `authorize()` (authoritative) narrowed by conversation membership, exactly as the rest of
 * the aggregate does: organization-wide scope skips the membership row, everyone else must be in the
 * channel. A `last_read_message_id` that resolves to a message in another conversation is a 400 with
 * no write — a read position can only ever point at a message in its own channel.
 */

/** What the GET/PUT single-conversation route returns. */
export interface ConversationReadStateView {
  readonly conversationId: string;
  /** The last message the caller has read, or null when they have read nothing here yet. */
  readonly lastReadMessageId: string | null;
  /** When the caller last advanced their position, ISO-8601, or null when unread. */
  readonly readAt: string | null;
  /** R7: the newest message delivered to the caller here (receipts), or null. */
  readonly lastDeliveredMessageId?: string | null;
  /** Messages in the channel created after the last-read message; the whole channel when unread. */
  readonly unreadCount: number;
}

/** One entry of the "all my conversations" view. */
export interface ConversationUnreadView {
  readonly conversationId: string;
  readonly lastReadMessageId: string | null;
  readonly unreadCount: number;
}

export class ConversationReadStateService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: ConversationsRepository,
    private readonly readState: ConversationReadStateRepository,
    private readonly receiptsStore: MessageReceiptsRepository = new MessageReceiptsRepository(),
  ) {}

  /** R7: who one message was delivered to and read by. 404 when unreachable or elsewhere. */
  async receipts(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<MessageReceiptsView> {
    return this.database.read(context, async (runner) => {
      const conversation = await this.conversations.findById(runner, context, conversationId);
      const message = await this.conversations.findMessageById(runner, context, messageId);
      if (
        !conversation ||
        !message ||
        message.conversationId !== conversationId ||
        !(await this.mayReach(runner, context, principal, conversation))
      ) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      const rows = await this.receiptsStore.listPositions(runner, context, conversationId);
      return deriveReceipts(rows, Number(message.sequenceNo), message.authorUserId);
    });
  }

  /** The caller's read position and unread count in one channel. 404 if unreachable. */
  async get(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationReadStateView> {
    return this.database.read(context, async (runner) => {
      const conversation = await this.conversations.findById(runner, context, conversationId);
      if (!conversation || !(await this.mayReach(runner, context, principal, conversation))) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      const row = await this.readState.findForMembership(
        runner,
        context,
        conversationId,
        readerOf(principal),
      );
      const threshold = await this.threshold(runner, context, conversationId, row);
      const unreadCount = await this.readState.countMessagesAfter(
        runner,
        context,
        conversationId,
        threshold,
      );

      return {
        conversationId,
        lastReadMessageId: row?.lastReadMessageId ?? null,
        readAt: row ? row.readAt.toISOString() : null,
        lastDeliveredMessageId: row?.lastDeliveredMessageId ?? null,
        unreadCount,
      };
    });
  }

  /**
   * R7 receipts: advance the caller's delivered and/or read position. Each position only ever moves
   * forward (by the channel's sequence), so a late, out-of-order PUT from a second tab is a no-op
   * rather than a step backwards. A delivered position needs an existing row: `last_read_message_id`
   * is NOT NULL, and inventing one would mark messages read.
   */
  async advance(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    positions: { readonly lastReadMessageId?: string; readonly lastDeliveredMessageId?: string },
  ): Promise<ConversationReadStateView> {
    if (positions.lastReadMessageId !== undefined) {
      await this.markRead(context, principal, conversationId, positions.lastReadMessageId);
    }
    const delivered = positions.lastDeliveredMessageId;
    if (delivered !== undefined) {
      await this.database.transaction(context, async (tx) => {
        const conversation = await this.conversations.findById(tx, context, conversationId);
        const message = await this.conversations.findMessageById(tx, context, delivered);
        if (!conversation || !message) throw new ApiError(404, 'not_found', MESSAGES.notFound);
        if (!(await this.mayReach(tx, context, principal, conversation))) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound);
        }
        if (message.conversationId !== conversationId) {
          throw new ApiError(400, 'validation_failed', 'The message is not in this conversation', [
            { field: 'lastDeliveredMessageId', message: 'must be a message in this conversation' },
          ]);
        }
        const row = await this.readState.findForMembership(
          tx,
          context,
          conversationId,
          readerOf(principal),
        );
        if (!row) return;
        const current = await this.sequenceOf(tx, context, row.lastDeliveredMessageId);
        if (!advances(current, Number(message.sequenceNo))) return;
        await this.readState.setDelivered(
          tx,
          context,
          conversationId,
          readerOf(principal),
          delivered,
        );
      });
    }
    return this.get(context, principal, conversationId);
  }

  /** Advance the caller's read position. Resolves conversation + message before authorizing. */
  async markRead(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<ConversationReadStateView> {
    return this.database.transaction(context, async (tx) => {
      // Resolve the conversation and the message before authorizing, so an unreachable channel is a
      // 404 that reveals nothing (`ConversationsService`'s rule).
      const conversation = await this.conversations.findById(tx, context, conversationId);
      if (!conversation) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const message = await this.conversations.findMessageById(tx, context, lastReadMessageId);
      if (!message) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      if (!(await this.mayReach(tx, context, principal, conversation))) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      // The message exists in the tenant, but a read position may only ever point at a message in
      // its own channel. A message from another conversation is a 400 and nothing is written.
      if (message.conversationId !== conversationId) {
        throw new ApiError(400, 'validation_failed', 'The message is not in this conversation', [
          { field: 'lastReadMessageId', message: 'must be a message in this conversation' },
        ]);
      }

      // R7: monotonic — a position never moves backwards. A client person's row names their
      // `client_memberships` id (0278), an internal member's their `memberships` id.
      const existing = await this.readState.findForMembership(
        tx,
        context,
        conversationId,
        readerOf(principal),
      );
      const current = await this.sequenceOf(tx, context, existing?.lastReadMessageId ?? null);
      if (advances(current, Number(message.sequenceNo))) {
        await this.readState.upsert(
          tx,
          context,
          conversationId,
          readerOf(principal),
          lastReadMessageId,
        );
      }

      const row = await this.readState.findForMembership(
        tx,
        context,
        conversationId,
        readerOf(principal),
      );
      const unreadCount = await this.readState.countMessagesAfter(
        tx,
        context,
        conversationId,
        message.createdAt,
      );

      return {
        conversationId,
        lastReadMessageId: row?.lastReadMessageId ?? lastReadMessageId,
        readAt: row ? row.readAt.toISOString() : null,
        lastDeliveredMessageId: row?.lastDeliveredMessageId ?? null,
        unreadCount,
      };
    });
  }

  /** Every conversation the caller can read, with their unread count in each. */
  async listMine(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ConversationUnreadView[]> {
    return this.database.read(context, async (runner) => {
      // R7: every kind — channels, groups and direct conversations.
      const rows = [
        ...(await this.conversations.list(runner, context, {})),
        ...(await this.conversations.list(runner, context, { kind: 'group' })),
        ...(await this.conversations.list(runner, context, { kind: 'direct' })),
      ];
      const out: ConversationUnreadView[] = [];
      for (const conversation of rows) {
        if (!(await this.mayReach(runner, context, principal, conversation))) continue;
        const state = await this.readState.findForMembership(
          runner,
          context,
          conversation.id,
          readerOf(principal),
        );
        const threshold = await this.threshold(runner, context, conversation.id, state);
        const unreadCount = await this.readState.countMessagesAfter(
          runner,
          context,
          conversation.id,
          threshold,
        );
        out.push({
          conversationId: conversation.id,
          lastReadMessageId: state?.lastReadMessageId ?? null,
          unreadCount,
        });
      }
      return out;
    });
  }

  /**
   * The `created_at` unread is counted after: the last-read message's own timestamp when it still
   * exists (the canonical position), the row's `read_at` if that message is gone, and null — count
   * everything — when there is no read-state row at all.
   */
  private async threshold(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    row: { readonly lastReadMessageId: string; readonly readAt: Date } | null,
  ): Promise<Date | null> {
    if (!row) return null;
    const message = await this.conversations.findMessageById(
      runner,
      context,
      row.lastReadMessageId,
    );
    if (message && message.conversationId === conversationId) return message.createdAt;
    return row.readAt;
  }

  /** The channel sequence of a stored position's message; null when unset or gone. */
  private async sequenceOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string | null,
  ): Promise<number | null> {
    if (messageId === null) return null;
    const message = await this.conversations.findMessageById(runner, context, messageId);
    return message ? Number(message.sequenceNo) : null;
  }

  /**
   * The evaluator, then conversation membership. Both must pass; organization-wide scope skips the
   * membership row. `ConversationsService.mayReach` for `conversation.read`, inlined here so this
   * slice adds no method to the shared service.
   */
  private async mayReach(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    row: ConversationRow,
  ): Promise<boolean> {
    // R7: a group or a direct conversation is member-gated for everyone (ConversationsService).
    const memberGated = row.kind !== 'project_channel';
    const member = memberGated
      ? (await this.conversations.findMembership(runner, context, row.id, principal.userId)) !==
        null
      : false;
    const verdict = authorize({
      principal,
      capability: 'conversation.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: row.archivedAt === null ? 'active' : 'archived',
        conversationKind: row.kind,
        ...(memberGated ? { conversationMember: member } : {}),
      },
    });
    if (!verdict.allowed) return false;
    if (memberGated) return true;
    if (principal.hasOrgWideScope) return true;
    const membership = await this.conversations.findMembership(
      runner,
      context,
      row.id,
      principal.userId,
    );
    return membership !== null;
  }
}

/** Pure: whether a position at `next` moves forward from `current` (null = no position yet). */
export function advances(current: number | null, next: number): boolean {
  return current === null || next > current;
}

/**
 * Whose row the caller's position is: a client person's membership is a `client_memberships` row,
 * every other principal's a `memberships` row (0278).
 */
export function readerOf(principal: Principal): ReadStateReader {
  return { kind: principal.kind === 'client' ? 'client' : 'member', id: principal.membershipId };
}
