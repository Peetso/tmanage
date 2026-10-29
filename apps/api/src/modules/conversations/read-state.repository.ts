import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationReadState, messages } from '../../common/database/schema.js';
import type { ConversationReadStateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Conversation read-state store — read one member's last-read position in a channel, advance it, and
 * count what is unread against it (module CHAT, x250).
 *
 * Every method names a membership. There is no `list(context)` that returns a channel's positions: a
 * position is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the `home_widget_prefs` / `a11y_preferences` shape for per-membership
 * reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_conversation_read_state_member`. Two mark-reads racing for one member's row serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the position and its
 * timestamps. Validation that `lastReadMessageId` belongs to the conversation is the service's; this
 * store persists what it is given.
 */
export class ConversationReadStateRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
  ): Promise<ConversationReadStateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationReadState)
      .where(
        and(
          eq(conversationReadState.organizationId, context.organizationId),
          eq(conversationReadState.conversationId, conversationId),
          eq(conversationReadState.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or advance this member's read position in this channel. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(conversationReadState)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        conversationId,
        membershipId,
        lastReadMessageId,
        readAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          lastReadMessageId,
          readAt: sql`current_timestamp(3)`,
        },
      });
  }

  /**
   * Count the messages in a channel created after `after`, or every message when `after` is null (no
   * read position yet, so everything is unread). Self-scoped by the caller resolving the threshold
   * from their own read-state row.
   */
  async countMessagesAfter(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    after: Date | null,
  ): Promise<number> {
    const predicates = [
      eq(messages.organizationId, context.organizationId),
      eq(messages.conversationId, conversationId),
      // PA-03 (0245): a soft-deleted message is not unread.
      isNull(messages.deletedAt),
    ];
    if (after !== null) predicates.push(gt(messages.createdAt, after));

    const rows = await tenantDrizzle(runner)
      .select({ unread: sql<number>`count(*)` })
      .from(messages)
      .where(and(...predicates));
    return Number(rows[0]?.unread ?? 0);
  }
}
