import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationThreadReplies } from '../../common/database/schema.js';
import type { ConversationThreadReplyRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** What a caller supplies to append a reply. `organization_id` is never one of them. */
export interface AppendThreadReplyInput {
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly authorMembershipId: string;
  readonly body: string;
}

/**
 * x249's storage half — a message's thread replies, append-only.
 *
 * `ConversationsRepository`'s shape: `TenantContext` as the scoping parameter, no
 * `organizationId` on the input type, the runner handed in by the service so the append and its
 * read-back share the caller's transaction. There is deliberately no update and no delete: the
 * migration's trigger and `users.sql` refuse both, and this file offers no method that would
 * ask for them.
 */
export class ThreadRepliesRepository {
  /**
   * Append a reply and read it back inside the same runner.
   *
   * `created_at` is not supplied — the column defaults to `current_timestamp(3)`, so no caller
   * can place a reply into the middle of a thread's order.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendThreadReplyInput,
  ): Promise<ConversationThreadReplyRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(conversationThreadReplies)
      .values({
        id,
        organizationId: context.organizationId,
        conversationId: input.conversationId,
        rootMessageId: input.rootMessageId,
        authorMembershipId: input.authorMembershipId,
        body: input.body,
        createdAt: sql`current_timestamp(3)`,
      });

    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationThreadReplies)
      .where(
        and(
          eq(conversationThreadReplies.organizationId, context.organizationId),
          eq(conversationThreadReplies.id, id),
        ),
      )
      .limit(1);
    const created = rows[0];
    if (!created) throw new Error('thread reply vanished immediately after insert');
    return created;
  }

  /** A root message's replies, oldest first — the order the read exposes. */
  async listByRoot(
    runner: TenantQueryRunner,
    context: TenantContext,
    rootMessageId: string,
  ): Promise<readonly ConversationThreadReplyRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(conversationThreadReplies)
      .where(
        and(
          eq(conversationThreadReplies.organizationId, context.organizationId),
          eq(conversationThreadReplies.rootMessageId, rootMessageId),
        ),
      )
      .orderBy(asc(conversationThreadReplies.createdAt), asc(conversationThreadReplies.id));
  }
}
