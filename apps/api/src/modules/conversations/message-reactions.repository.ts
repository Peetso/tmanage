import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { messageReactions, messages } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** One emoji's count on one of several messages (C5 batched read). */
export interface MessageReactionCount extends ReactionCount {
  readonly messageId: string;
}

/** One emoji's count on a message. */
export interface ReactionCount {
  readonly emoji: string;
  readonly count: number;
}

/**
 * x246 message reactions — CH-07 "Message actions"'s storage half.
 *
 * Every query is scoped by `organization_id`; the layer-3 guard (`TENANT_TABLES`) refuses an
 * unscoped one, and the composite predicates keep a reaction, its message and its membership in
 * the same studio. Policy — the capability gate and the conversation-membership check — lives in
 * the service; this file is queries only, per the lint boundary that also keeps drizzle out of
 * the service.
 */
export class MessageReactionsRepository {
  /**
   * Add the acting membership's reaction, idempotently.
   *
   * A single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_message_reactions_identity`: a
   * second add of the same (message, membership, emoji) collides on the unique key and updates
   * the row to itself rather than inserting a duplicate or erroring, so two adds racing for the
   * same reaction serialise on the key. The id, tenant and timestamp come from here, never from
   * input, and `created_at` is left untouched on the duplicate path so the original stands.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    membershipId: string,
    emoji: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(messageReactions)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        messageId,
        membershipId,
        emoji,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { emoji } });
  }

  /**
   * Remove the acting membership's reaction, idempotently.
   *
   * Predicated on `membership_id = the acting membership`: a member can only ever clear their
   * own reaction, never another's. Deleting a reaction that is not there is not an error — the
   * caller wanted it gone and it is.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    membershipId: string,
    emoji: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.organizationId, context.organizationId),
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.membershipId, membershipId),
          eq(messageReactions.emoji, emoji),
        ),
      );
  }

  /** The tally: how many memberships reacted with each emoji on this message, emoji order. */
  async tally(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<readonly ReactionCount[]> {
    const rows = await tenantDrizzle(runner)
      .select({ emoji: messageReactions.emoji, count: count() })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.organizationId, context.organizationId),
          eq(messageReactions.messageId, messageId),
        ),
      )
      .groupBy(messageReactions.emoji)
      .orderBy(asc(messageReactions.emoji));
    return rows.map((row) => ({ emoji: row.emoji, count: Number(row.count) }));
  }

  /** The emojis the acting membership itself reacted with on this message. */
  async mine(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    membershipId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.organizationId, context.organizationId),
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.membershipId, membershipId),
        ),
      );
    return rows.map((row) => row.emoji);
  }
  /**
   * C5 (batched read): which of `messageIds` are messages of `conversationId` in this studio. The
   * batch tally answers only for these, so an id from another channel is dropped, never tallied.
   */
  async messageIdsInConversation(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<readonly string[]> {
    if (messageIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, conversationId),
          inArray(messages.id, [...messageIds]),
          // PA-03 (0245): a soft-deleted message answers for nothing in a list read.
          isNull(messages.deletedAt),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** C5: the tallies of several messages in one query, message then emoji order. */
  async tallyMany(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageIds: readonly string[],
  ): Promise<readonly MessageReactionCount[]> {
    if (messageIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        count: count(),
      })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.organizationId, context.organizationId),
          inArray(messageReactions.messageId, [...messageIds]),
        ),
      )
      .groupBy(messageReactions.messageId, messageReactions.emoji)
      .orderBy(asc(messageReactions.messageId), asc(messageReactions.emoji));
    return rows.map((row) => ({
      messageId: row.messageId,
      emoji: row.emoji,
      count: Number(row.count),
    }));
  }

  /** C5: the acting membership's own reactions on several messages, in one query. */
  async mineMany(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageIds: readonly string[],
    membershipId: string,
  ): Promise<readonly { readonly messageId: string; readonly emoji: string }[]> {
    if (messageIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.organizationId, context.organizationId),
          inArray(messageReactions.messageId, [...messageIds]),
          eq(messageReactions.membershipId, membershipId),
        ),
      );
  }
}
