import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { conversationPinnedMessages } from '../../common/database/schema.js';
import type { ConversationPinnedMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * The driver's own error code, unwrapped from Drizzle's wrapper first — the same trap
 * `ConversationsRepository.driverErrorCode` records: a duplicate-key error reacted to inside a
 * transaction carries the driver code only on `cause`, which `unwrapQueryError` exposes.
 */
function driverErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  const candidate = unwrapped as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

export interface PinMessageInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly pinnedByUserId: string;
}

/**
 * x247's storage half — a conversation's pinned messages, `conversation_pinned_messages` (0119).
 *
 * `ConversationsRepository`'s shape: `TenantContext` scopes every query, no `organizationId` on
 * any input, not a serialised row. Nothing here resolves the conversation or the message or
 * checks a capability — that is the service's, which resolves both tenant-scoped before it writes.
 *
 * The pin is idempotent by identity, the way `addMember` is: {@link pin} returns the row that
 * already exists rather than failing, so a repeated PUT is a no-op that answers with the pin. The
 * only writes are INSERT (pin) and DELETE (unpin); there is no UPDATE path, which is why
 * `scripts/db/users.sql` grants the runtime credential INSERT and DELETE and withholds UPDATE.
 */
export class MessagePinsRepository {
  /** A conversation's pins, oldest first — CH-02's pinned strip reads in the order they were pinned. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<readonly ConversationPinnedMessageRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(conversationPinnedMessages)
      .where(
        and(
          eq(conversationPinnedMessages.organizationId, context.organizationId),
          eq(conversationPinnedMessages.conversationId, conversationId),
        ),
      )
      .orderBy(asc(conversationPinnedMessages.pinnedAt), asc(conversationPinnedMessages.id));
  }

  /** How many messages are pinned in a conversation — the cap is checked against this. */
  async count(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ pinned: sql<number>`count(*)` })
      .from(conversationPinnedMessages)
      .where(
        and(
          eq(conversationPinnedMessages.organizationId, context.organizationId),
          eq(conversationPinnedMessages.conversationId, conversationId),
        ),
      );
    return Number(rows[0]?.pinned ?? 0);
  }

  async findPin(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    messageId: string,
  ): Promise<ConversationPinnedMessageRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationPinnedMessages)
      .where(
        and(
          eq(conversationPinnedMessages.organizationId, context.organizationId),
          eq(conversationPinnedMessages.conversationId, conversationId),
          eq(conversationPinnedMessages.messageId, messageId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Pin a message. Idempotent by identity: pinning a message that is already pinned returns the
   * existing pin rather than failing, so a repeated PUT is the no-op the caller wants. A race with
   * a concurrent pin collides on `uq_conversation_pinned_messages_pin`, and the row the loser
   * reads back is the same pin — the unique key held, which is the point of having it.
   */
  async pin(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: PinMessageInput,
  ): Promise<ConversationPinnedMessageRow> {
    const existing = await this.findPin(runner, context, input.conversationId, input.messageId);
    if (existing) return existing;

    const id = uuidv7();
    try {
      await tenantDrizzle(runner).insert(conversationPinnedMessages).values({
        id,
        organizationId: context.organizationId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        pinnedByUserId: input.pinnedByUserId,
        pinnedAt: sql`current_timestamp(3)`,
      });
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        const raced = await this.findPin(runner, context, input.conversationId, input.messageId);
        if (raced) return raced;
      }
      throw error;
    }

    const created = await this.findPin(runner, context, input.conversationId, input.messageId);
    if (!created) {
      // The insert reported success, so the row is there; a miss here is a bug, not a state.
      throw new Error('pin insert did not produce a row');
    }
    return created;
  }

  /** Unpin a message. Returns whether a row was removed, so the service can tell a no-op apart. */
  async unpin(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    messageId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(conversationPinnedMessages)
      .where(
        and(
          eq(conversationPinnedMessages.organizationId, context.organizationId),
          eq(conversationPinnedMessages.conversationId, conversationId),
          eq(conversationPinnedMessages.messageId, messageId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
