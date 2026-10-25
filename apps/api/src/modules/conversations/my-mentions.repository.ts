import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationMemberships, conversations, messages } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * CHAT "my mentions" (x254) — the read-only storage half.
 *
 * No table of its own: mentions are computed over the stored `messages` bodies at read time.
 * `messages.body` is `richTextToPlainText` of what was said (see the schema note on `body_rich`),
 * so a mention token a member typed is present in `body` whether the message was plain or rich.
 *
 * ## Where the tenant and relation gates live
 *
 * Every query here is scoped to `context.organizationId`, so nothing crosses a tenant. The
 * **relation** gate — a caller sees a mention only in a conversation they are a member of — is the
 * service's, applied over {@link listMemberConversationIds}, exactly as `ConversationsService.list`
 * filters a channel list by membership rather than trusting the row read. {@link listMentionCandidates}
 * therefore returns the org-wide matches newest-first and bounded; it is the service that drops the
 * ones outside the caller's memberships, and the controller test proves that drop.
 */

/** One message that mentions the caller, joined to its channel for the list and the jump target. */
export interface MentionCandidateRow {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly projectId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: Date;
  /** The channel's archive instant — the evaluator's lifecycle input for the F13 relation gate. */
  readonly archivedAt: Date | null;
}

/**
 * A bound on the org-wide scan. A mentions inbox is a recent view, not an archive export; the
 * newest {@link SCAN_LIMIT} matches are read, the caller's memberships filter them, and the page
 * is taken from what remains. Ordered by `created_at` then `id` so the cut is deterministic.
 */
const SCAN_LIMIT = 500;

/** Escape a value for a `LIKE` pattern so its own `%`/`_`/`\` cannot act as wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class MyMentionsRepository {
  /**
   * The conversation ids the caller is a member of, tenant-scoped. The service turns this into the
   * relation gate: a mention in a conversation whose id is not here never reaches the caller.
   */
  async listMemberConversationIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ conversationId: conversationMemberships.conversationId })
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.userId, userId),
        ),
      );
    return rows.map((row) => row.conversationId);
  }

  /**
   * The newest live messages in the tenant whose body carries the mention `token`, joined to their
   * channel. Deleted (moderated) messages are excluded — a taken-down message withholds its body,
   * so it cannot surface here either. Bounded by {@link SCAN_LIMIT}; the relation filter is the
   * service's.
   */
  async listMentionCandidates(
    runner: TenantQueryRunner,
    context: TenantContext,
    token: string,
  ): Promise<readonly MentionCandidateRow[]> {
    const pattern = `%${escapeLike(token)}%`;
    return tenantDrizzle(runner)
      .select({
        messageId: messages.id,
        conversationId: messages.conversationId,
        conversationName: conversations.name,
        projectId: conversations.projectId,
        authorUserId: messages.authorUserId,
        body: messages.body,
        createdAt: messages.createdAt,
        archivedAt: conversations.archivedAt,
      })
      .from(messages)
      .innerJoin(
        conversations,
        and(
          eq(conversations.organizationId, messages.organizationId),
          eq(conversations.id, messages.conversationId),
        ),
      )
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          isNull(messages.deletedAt),
          like(messages.body, pattern),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(SCAN_LIMIT);
  }
}
