import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationMutes } from '../../common/database/schema.js';
import type { ConversationMuteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * CH-09's conversation-mute store — read one member's mute state for one conversation, write it, and
 * nothing else (module Chat, x252).
 *
 * Both methods name a `(conversationId, membershipId)` pair. There is no `list(context)` that returns
 * a channel's muters or a member's muted channels: a mute row is one member's own preference, and a
 * method without both parameters would be the one place that rule could be dropped — the same shape
 * `pref_quiet_hours` (0093) takes for its per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_conversation_mutes_org_conv_membership`. Two saves racing for one member's row serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only `muted`, and `updated_at`
 * follows the column's `ON UPDATE`.
 */
export class ConversationMuteRepository {
  async findMute(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
  ): Promise<ConversationMuteRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationMutes)
      .where(
        and(
          eq(conversationMutes.organizationId, context.organizationId),
          eq(conversationMutes.conversationId, conversationId),
          eq(conversationMutes.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's mute state on this conversation. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
    muted: boolean,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(conversationMutes)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        conversationId,
        membershipId,
        muted,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          muted,
        },
      });
  }
}
