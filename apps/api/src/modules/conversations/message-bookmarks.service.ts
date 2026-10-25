import { authorize } from '@tmanage/domain';
import type { Principal, RichTextDocument } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageBookmarksRepository } from './message-bookmarks.repository.js';

/**
 * x248 — a member privately saves/unsaves a chat message, and lists their saved messages across
 * conversations (CH-07 "Message actions": Save). Distinct from `document_bookmarks` (x242).
 *
 * ## The gate is the conversation's, resolved before it is applied
 *
 * A save is not its own authority: the right to save a message is the right to *read* it, so
 * every write here passes the same gate `ConversationsService` applies to reading a message —
 * `authorize('conversation.read')` (the project relation, evaluator-owned) **and** conversation
 * membership, unless the caller holds organization-wide scope. The order is deliberate and
 * mirrors `ConversationsService.mayReach`: the conversation and the message are resolved
 * tenant-scoped first (a row that does not exist, or a message that belongs to another
 * conversation, is a 404 with no authorization leak), then the gate runs, and only a caller who
 * passes both halves reaches the insert. A caller who is not a member of the conversation is
 * refused with 404 **before any row is written** — the relation gate, not a failed insert.
 *
 * ## Why 404 and not 403
 *
 * `ConversationsService` records it: 403 confirms the channel exists, and a channel's existence is
 * itself information. A caller with no relation to the conversation is told the same "not found"
 * whether the message is real or not.
 *
 * ## Self-scoped
 *
 * The bookmark belongs to `context.membershipId` — the membership that authorised this request.
 * The repository scopes every read, the save and the unsave by it, so one member never sees or
 * removes another's saved messages, and the "My Saved Messages" list is the caller's own.
 */

/** What a caller is allowed to see of one saved message. */
export interface SavedMessageView {
  readonly messageId: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  /** `null` once the message has been moderated — the same withholding `MessageView` applies. */
  readonly body: string | null;
  readonly bodyRich: RichTextDocument | null;
  readonly bookmarkedAt: string;
}

export class MessageBookmarksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly bookmarks: MessageBookmarksRepository = new MessageBookmarksRepository(),
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
  ) {}

  /**
   * Save a message. Idempotent: saving one already saved is a no-op that still answers 200. The
   * conversation and message are resolved and the read gate applied first; a caller who cannot
   * reach the message gets a 404 and nothing is written.
   */
  async bookmark(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.resolveReadable(context, principal, conversationId, messageId, tx);
      await this.bookmarks.insert(tx, context, messageId);
    });
  }

  /**
   * Unsave a message. Idempotent — unsaving one that is not saved removes nothing and still
   * answers 204. The same read gate applies first, so an unsave cannot be used to probe a
   * conversation the caller has no relation to.
   */
  async unbookmark(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.resolveReadable(context, principal, conversationId, messageId, tx);
      await this.bookmarks.deleteOwn(tx, context, messageId);
    });
  }

  /** The acting membership's saved messages, newest first, across the conversations it still reads. */
  async listMine(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly SavedMessageView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.bookmarks.listMine(runner, context, {
        userId: principal.userId,
        hasOrgWideScope: principal.hasOrgWideScope,
      }),
    );
    // F13: a channel membership row is not authority on its own — a member removed from the
    // channel's project keeps a stale row. Each saved message must also pass the evaluator's
    // project relation, exactly as `resolveReadable` (and `ConversationsService.mayReach`) does.
    const readable = rows.filter(
      (row) =>
        authorize({
          principal,
          capability: 'conversation.read',
          resource: {
            organizationId: context.organizationId,
            projectId: row.projectId,
            audience: 'internal',
            lifecycle: row.archivedAt === null ? 'active' : 'archived',
          },
        }).allowed,
    );
    return readable.map((row) => ({
      messageId: row.messageId,
      conversationId: row.conversationId,
      authorUserId: row.authorUserId,
      sequenceNo: row.sequenceNo,
      body: row.body,
      bodyRich: (row.bodyRich as RichTextDocument | null) ?? null,
      bookmarkedAt: row.bookmarkedAt.toISOString(),
    }));
  }

  /**
   * Resolve the conversation and message tenant-scoped, then apply the conversation read gate.
   * Throws 404 if the conversation does not exist, the message does not exist or belongs to a
   * different conversation, or the caller may not read the conversation (relation gate) — in every
   * case before any write. Runs on the passed runner so it shares the caller's transaction.
   */
  private async resolveReadable(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    runner: TenantQueryRunner,
  ): Promise<void> {
    const conversation = await this.conversations.findById(runner, context, conversationId);
    if (!conversation) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const message = await this.conversations.findMessageById(runner, context, messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'conversation.read',
      resource: {
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    if (principal.hasOrgWideScope) return;

    const membership = await this.conversations.findMembership(
      runner,
      context,
      conversationId,
      principal.userId,
    );
    if (!membership) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }
}
