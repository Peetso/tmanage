import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import {
  conversationMemberships,
  conversations,
  messageBookmarks,
  messages,
} from '../../common/database/schema.js';
import type { MessageBookmarkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * The driver's own error code, unwrapped first — `ConversationsRepository` records why Drizzle
 * hides it on `cause` inside a transaction. A concurrent save that loses the unique-key race
 * reaches here as this code, not a 500.
 */
function driverErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  const candidate = unwrapped as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

/**
 * One saved message, joined to the message it names. `bookmarkedAt` is when the caller saved it;
 * `body`/`bodyRich` are `null` for a moderated message, exactly as `MessageView` withholds them —
 * a saved reference must not read back out a body that was taken down.
 */
export interface SavedMessageRow {
  readonly bookmarkId: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly body: string | null;
  readonly bodyRich: unknown;
  readonly bookmarkedAt: Date;
  /** The channel's project, for the service's per-row `authorize('conversation.read')` (F13). */
  readonly projectId: string | null;
  /** The channel's archive instant, for the evaluator's lifecycle input. */
  readonly archivedAt: Date | null;
}

/**
 * x248's data half — a membership's saved messages, and the idempotent save/unsave.
 *
 * Every method is scoped by `membership_id = context.membershipId`, so a save is private to the
 * membership that made it and one member never reads, saves under, or removes another's. The list
 * additionally narrows to conversations the caller still reads: it joins through
 * `conversation_memberships` on the caller's `userId` unless the caller holds organization-wide
 * scope, so a message in a channel the caller has since left drops out of "My Saved Messages"
 * rather than leaking its current body.
 */
export class MessageBookmarksRepository {
  /** The membership's existing bookmark of this message, if any — the idempotency probe. */
  async findBookmark(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<MessageBookmarkRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messageBookmarks)
      .where(
        and(
          eq(messageBookmarks.organizationId, context.organizationId),
          eq(messageBookmarks.messageId, messageId),
          eq(messageBookmarks.membershipId, context.membershipId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Save a message for the acting membership, idempotently. The id, tenant and membership come
   * from the context, never from input. A concurrent save that loses the unique-key race is
   * handed the row that won rather than a 500 — "make sure this message is saved" is what the
   * caller wants and a duplicate is not an error worth making them handle.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<MessageBookmarkRow> {
    const existing = await this.findBookmark(runner, context, messageId);
    if (existing) return existing;

    try {
      await tenantDrizzle(runner)
        .insert(messageBookmarks)
        .values({
          id: uuidv7(),
          organizationId: context.organizationId,
          messageId,
          membershipId: context.membershipId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        const raced = await this.findBookmark(runner, context, messageId);
        if (raced) return raced;
      }
      throw error;
    }

    const created = await this.findBookmark(runner, context, messageId);
    if (!created) throw new Error('message_bookmarks row vanished immediately after insert');
    return created;
  }

  /**
   * Unsave a message for the acting membership. Scoped by `membership_id`, so a message the caller
   * never saved (or another member's save) removes nothing — the service answers 204 either way,
   * because DELETE is idempotent and "it is not saved" is the state the caller asked for.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(messageBookmarks)
      .where(
        and(
          eq(messageBookmarks.organizationId, context.organizationId),
          eq(messageBookmarks.messageId, messageId),
          eq(messageBookmarks.membershipId, context.membershipId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * The acting membership's saved messages, newest first, across conversations — projecting only
   * those in conversations the caller still reads (unless organization-wide). The join to
   * `messages` gives the referenced message; the join to `conversation_memberships` on the
   * caller's `userId` is the readability filter, skipped for an org-wide caller whose access
   * derives from scope rather than a membership row.
   */
  async listMine(
    runner: TenantQueryRunner,
    context: TenantContext,
    caller: { readonly userId: string; readonly hasOrgWideScope: boolean },
  ): Promise<readonly SavedMessageRow[]> {
    const db = tenantDrizzle(runner);
    const projection = {
      bookmarkId: messageBookmarks.id,
      messageId: messages.id,
      conversationId: messages.conversationId,
      authorUserId: messages.authorUserId,
      sequenceNo: messages.sequenceNo,
      body: messages.body,
      bodyRich: messages.bodyRich,
      deletedAt: messages.deletedAt,
      bookmarkedAt: messageBookmarks.createdAt,
      projectId: conversations.projectId,
      archivedAt: conversations.archivedAt,
    };

    const base = db
      .select(projection)
      .from(messageBookmarks)
      .innerJoin(
        messages,
        and(
          eq(messages.organizationId, messageBookmarks.organizationId),
          eq(messages.id, messageBookmarks.messageId),
        ),
      )
      .innerJoin(
        conversations,
        and(
          eq(conversations.organizationId, messages.organizationId),
          eq(conversations.id, messages.conversationId),
          // R7: project channels only (see `MessageBookmarksService.resolveReadable`).
          eq(conversations.kind, 'project_channel'),
        ),
      );

    const scoped = caller.hasOrgWideScope
      ? base
      : base.innerJoin(
          conversationMemberships,
          and(
            eq(conversationMemberships.organizationId, messages.organizationId),
            eq(conversationMemberships.conversationId, messages.conversationId),
            eq(conversationMemberships.userId, caller.userId),
          ),
        );

    const rows = await scoped
      .where(
        and(
          eq(messageBookmarks.organizationId, context.organizationId),
          eq(messageBookmarks.membershipId, context.membershipId),
        ),
      )
      .orderBy(desc(messageBookmarks.createdAt), desc(messageBookmarks.id));

    return rows.map((row) => ({
      bookmarkId: row.bookmarkId,
      messageId: row.messageId,
      conversationId: row.conversationId,
      authorUserId: row.authorUserId,
      sequenceNo: Number(row.sequenceNo),
      body: row.deletedAt === null ? row.body : null,
      bodyRich: row.deletedAt === null ? row.bodyRich : null,
      bookmarkedAt: row.bookmarkedAt,
      projectId: row.projectId,
      archivedAt: row.archivedAt,
    }));
  }
}
