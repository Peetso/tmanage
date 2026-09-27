import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MyMentionsRepository } from './my-mentions.repository.js';

/**
 * CHAT "my mentions" (x254) — a read-only list of the recent messages that mention the acting
 * member, across the conversations they belong to. No table, no write; it scans stored message
 * bodies at read time, behind the `conversation.read` capability the controller requires.
 *
 * ## The relation gate is this file's, and it is the whole of the slice
 *
 * `CapabilityGuard` on the route asks the coarse question — may this role read conversations at
 * all — and refuses a caller without `conversation.read` before this service runs. What the
 * capability cannot express is the **relation**: a member may read *their* channels, not every
 * channel in the tenant. This service adds that filter the way `ConversationsService.list` adds
 * it — it loads the caller's conversation memberships and keeps only the mentions whose channel
 * is among them. A message that mentions the caller in a conversation they are not a member of is
 * dropped here and never reaches the wire, which is exactly what the controller test proves.
 *
 * The mention token is `@` followed by the caller's own user id — the principal the list is for.
 * Because the scan is bounded ({@link MyMentionsRepository} caps it) and then relation-filtered,
 * the page a caller sees is the newest matches in their own rooms and nothing else.
 */

/** One mention on the wire. Paired Exact with the web `MentionSummary` in the contracts gate. */
export interface MentionView {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly projectId: string;
  readonly authorUserId: string;
  /** The message body as stored (plain text of what was said). */
  readonly body: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export interface ListMentionsOptions {
  readonly page?: number;
}

/** A page holds this many mentions. A recent inbox, not an export. */
const PAGE_SIZE = 50;

/** The mention token a body must contain for the caller: `@` then their user id. */
function mentionToken(userId: string): string {
  return `@${userId}`;
}

export class MyMentionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly mentions: MyMentionsRepository = new MyMentionsRepository(),
  ) {}

  /**
   * The caller's mentions, newest first, paged. `page` is 1-based; a missing or out-of-range page
   * is a 400 rather than a silent empty list, so a screen's paging bug is visible.
   */
  async listMyMentions(
    context: TenantContext,
    options: ListMentionsOptions = {},
  ): Promise<readonly MentionView[]> {
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'page', message: 'must be a positive integer' },
      ]);
    }

    const token = mentionToken(context.userId);

    // The relation gate's inputs: the caller's own memberships, and the org-wide candidate scan.
    const memberIds = new Set(
      await this.database.read(context, (runner) =>
        this.mentions.listMemberConversationIds(runner, context, context.userId),
      ),
    );
    const candidates = await this.database.read(context, (runner) =>
      this.mentions.listMentionCandidates(runner, context, token),
    );

    // The gate itself: a mention survives only if its channel is one the caller belongs to.
    const visible = candidates.filter((row) => memberIds.has(row.conversationId));

    const start = (page - 1) * PAGE_SIZE;
    return visible.slice(start, start + PAGE_SIZE).map((row) => ({
      messageId: row.messageId,
      conversationId: row.conversationId,
      conversationName: row.conversationName,
      projectId: row.projectId,
      authorUserId: row.authorUserId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
