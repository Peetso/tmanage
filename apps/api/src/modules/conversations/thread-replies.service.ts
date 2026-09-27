import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ThreadRepliesRepository } from './thread-replies.repository.js';
import type {
  ConversationRow,
  ConversationThreadReplyRow,
  MessageRow,
} from '../../common/database/schema.js';

/** One reply, as a caller may see it. */
export interface ThreadReplyView {
  readonly id: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  /** The membership that authored it — the actor inside this studio, never a bare user id. */
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** A message's thread: its replies, oldest first, and how many there are. */
export interface ThreadView {
  readonly rootMessageId: string;
  readonly replies: readonly ThreadReplyView[];
  readonly count: number;
}

/** What the caller wants to say. */
export interface AppendThreadReplyCommand {
  readonly body: string;
}

function toReplyView(row: ConversationThreadReplyRow): ThreadReplyView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    rootMessageId: row.rootMessageId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * x249's application service — reply to a message's thread, and read the thread.
 *
 * The access model is `ConversationsService`'s, restated for this surface rather than reached
 * into: `authorize()` first and authoritative, then conversation membership, which can only
 * narrow. It reuses `conversation.write` and `conversation.read` — no new capability — and
 * writes only its own append-only table. It does **not** touch `conversations.service`; the
 * conversation and root message are resolved through a read-only `ConversationsRepository`
 * handle it owns, the same way `ConversationsModule` owns its read-only `ProjectsRepository`.
 *
 * ## Resolution before authorization, and why the answer is always 404
 *
 * The conversation and the root message are loaded first. A missing conversation, a missing
 * message, or a message that belongs to another conversation is a 404 before the relation gate
 * runs — a caller who could tell "no such thread" from "you may not read this thread" apart
 * could probe for the existence of channels and messages they have no relation to. The
 * relation gate then answers 404 as well, for the reason `ConversationsService` gives: a 403
 * confirms the row exists, and a channel's existence is itself information.
 *
 * The author is `context.membershipId` — the membership row that authorised this request. It
 * is never a field on the command, so no caller can post a reply as somebody else.
 */
export class ThreadRepliesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly replies: ThreadRepliesRepository = new ThreadRepliesRepository(),
  ) {}

  async listReplies(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    rootMessageId: string,
  ): Promise<ThreadView> {
    await this.resolveReachableRoot(
      context,
      principal,
      conversationId,
      rootMessageId,
      'conversation.read',
    );

    const rows = await this.database.read(context, (runner) =>
      this.replies.listByRoot(runner, context, rootMessageId),
    );
    return {
      rootMessageId,
      replies: rows.map(toReplyView),
      count: rows.length,
    };
  }

  async appendReply(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    rootMessageId: string,
    command: AppendThreadReplyCommand,
  ): Promise<ThreadReplyView> {
    const conversation = await this.resolveReachableRoot(
      context,
      principal,
      conversationId,
      rootMessageId,
      'conversation.write',
    );
    if (conversation.archivedAt !== null) {
      // `authorize()` already refuses a write against an archived resource; this repeats it
      // with a message a person can act on rather than a bare 404.
      throw new ApiError(409, 'conflict', 'This channel is archived, so nothing can be posted');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.replies.append(tx, context, {
        conversationId,
        rootMessageId,
        authorMembershipId: context.membershipId,
        body: command.body,
      }),
    );
    return toReplyView(row);
  }

  /**
   * Resolve the conversation and root message, then apply the relation gate — every failure a
   * 404. Returns the conversation row so the write path can read its lifecycle.
   */
  private async resolveReachableRoot(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    rootMessageId: string,
    capability: Extract<Capability, 'conversation.read' | 'conversation.write'>,
  ): Promise<ConversationRow> {
    const conversation = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!conversation) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const message = await this.database.read(context, (runner) =>
      this.conversations.findMessageById(runner, context, rootMessageId),
    );
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    if (!(await this.mayReach(context, principal, conversation, message, capability))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return conversation;
  }

  /**
   * The evaluator, then conversation membership. Both must pass; organization-wide scope skips
   * the membership row for the reason `ConversationsService.mayReach` records.
   */
  private async mayReach(
    context: TenantContext,
    principal: Principal,
    conversation: ConversationRow,
    _message: MessageRow,
    capability: Extract<Capability, 'conversation.read' | 'conversation.write'>,
  ): Promise<boolean> {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) return false;

    if (principal.hasOrgWideScope) return true;

    const membership = await this.database.read(context, (runner) =>
      this.conversations.findMembership(runner, context, conversation.id, principal.userId),
    );
    return membership !== null;
  }
}
