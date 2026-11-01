import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  conversationMemberships,
  conversationReadState,
  conversations,
  messages,
  users,
} from '../../common/database/schema.js';
import type { MessageKind } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

export interface PortalChatGroupRow {
  readonly conversationId: string;
  readonly name: string;
  readonly photoFileAssetId: string | null;
  readonly lastMessageId: string | null;
  readonly lastMessageAt: Date | null;
  readonly pinnedAt: Date | null;
}

export interface PortalChatLastMessage {
  readonly id: string;
  readonly body: string;
  readonly kind: MessageKind;
  readonly deleted: boolean;
  readonly authorName: string;
}

/**
 * R7 slice 3 — the portal's own read of the chat list: only `kind = 'group'` conversations the
 * caller holds a membership row in. Its own query on purpose (no import from `modules/chat`): the
 * client door must not grow wider because the studio list does.
 */
export class PortalChatRepository {
  async listGroupsForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly PortalChatGroupRow[]> {
    return tenantDrizzle(runner)
      .select({
        conversationId: conversations.id,
        name: conversations.name,
        photoFileAssetId: conversations.photoFileAssetId,
        lastMessageId: conversations.lastMessageId,
        lastMessageAt: conversations.lastMessageAt,
        pinnedAt: conversationMemberships.pinnedAt,
      })
      .from(conversations)
      .innerJoin(
        conversationMemberships,
        and(
          eq(conversationMemberships.organizationId, conversations.organizationId),
          eq(conversationMemberships.conversationId, conversations.id),
          eq(conversationMemberships.userId, userId),
        ),
      )
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.kind, 'group'),
          isNull(conversations.archivedAt),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(200);
  }

  async lastMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, PortalChatLastMessage>> {
    if (messageIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({
        id: messages.id,
        body: messages.body,
        kind: messages.kind,
        deletedAt: messages.deletedAt,
        authorName: users.displayName,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          inArray(messages.id, [...messageIds]),
        ),
      );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          body: row.body,
          kind: row.kind,
          deleted: row.deletedAt !== null,
          authorName: row.authorName ?? '',
        },
      ]),
    );
  }

  /**
   * Unread top-level messages per group for a client reader: messages by someone else past the
   * client's own read marker (`client_membership_id`, 0278), the studio list's rule.
   */
  async unreadCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
    userId: string,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const db = tenantDrizzle(runner);
    const positions = await db
      .select({ conversationId: conversationReadState.conversationId, seq: messages.sequenceNo })
      .from(conversationReadState)
      .innerJoin(
        messages,
        and(
          eq(messages.organizationId, conversationReadState.organizationId),
          eq(messages.id, conversationReadState.lastReadMessageId),
        ),
      )
      .where(
        and(
          eq(conversationReadState.organizationId, context.organizationId),
          eq(conversationReadState.clientMembershipId, clientMembershipId),
          inArray(conversationReadState.conversationId, [...conversationIds]),
        ),
      );
    const readUpTo = new Map(positions.map((p) => [p.conversationId, Number(p.seq)]));
    const rows = await db
      .select({ conversationId: messages.conversationId, unread: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          isNull(messages.parentMessageId),
          isNull(messages.deletedAt),
          ne(messages.authorUserId, userId),
          or(
            ...conversationIds.map((id) =>
              and(eq(messages.conversationId, id), gt(messages.sequenceNo, readUpTo.get(id) ?? 0)),
            ),
          ),
        ),
      )
      .groupBy(messages.conversationId);
    return new Map(rows.map((row) => [row.conversationId, Number(row.unread)]));
  }
}
