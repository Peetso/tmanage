import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import {
  ConversationNameTakenError,
  ConversationNotFoundError,
  ConversationsRepository,
  ConversationVersionConflictError,
  DuplicateMessageError,
  InvalidThreadParentError,
  MessageNotFoundError,
} from './conversations.repository.js';
import type {
  AppendMessageInput,
  CreateConversationInput,
  ListConversationsOptions,
  ListMessagesOptions,
} from './conversations.repository.js';
import type {
  ConversationMembershipRow,
  ConversationRow,
  MessageRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * CHAT-001's application service — spec §3 steps 5 to 7 for the conversation aggregate.
 *
 * `WorkItemsService`'s shape: the repository stays free of policy, the controller free of both.
 * What is different is that this aggregate has **two** relations rather than one, and getting
 * the interaction between them right is most of the ticket.
 *
 * ## Two gates, and the narrower one is not the evaluator's
 *
 * `conversation.read` and `conversation.write` are relation-gated in `packages/domain`, and the
 * relation the evaluator knows is **project membership**. That is the right gate for a project
 * channel: TM-06 is the room a project's team talks in, and being on the project is what
 * entitles you to it.
 *
 * It is not sufficient on its own. `conversation_memberships` exists because `13-ENGINEERING`
 * §5 names it and because a project can hold more than one channel; a person on the project is
 * not thereby in every room on it. So this service applies a second, **narrowing** check: the
 * acting principal must be a member of the conversation, or hold organization-wide scope.
 *
 * The order matters and is deliberate. `authorize()` runs first and is authoritative — no
 * amount of conversation membership admits a client principal or a suspended member, because
 * the evaluator refuses those before any of this file's code runs. The membership check can
 * only ever take access away. A gate that could add access would be a second authorization
 * system, which is the thing `25-AUTH-AND-TENANT-ISOLATION` §4 forbids policy from being.
 *
 * ## Why a client principal cannot reach any of this
 *
 * No client role holds `conversation.read`, `conversation.write` or `conversation.moderate` —
 * `12-PERMISSION-MATRIX` §2 gives them "Moderate messages: No" or "Own only" and no internal
 * read at all, and `packages/domain/src/policies/capabilities.ts` records the absence as
 * load-bearing. `authorize()` refuses them twice over: once on the ceiling and once on the
 * independent internal-only guard.
 *
 * That has a consequence worth stating plainly, because it is the opposite of what this
 * ticket's motivation suggests. **CHAT-001 does not let a client reply to a clarification.**
 * It builds the room the studio talks in. A client-facing thread is a client-visible audience
 * on a conversation, which needs a projection and an evaluator relation that do not exist yet;
 * it is recorded as a named gap rather than smuggled in behind a capability nobody granted.
 *
 * ## What "not found" means here
 *
 * A conversation the principal has no relation to produces **404**, not 403, for the reason
 * `WorkItemsService` gives: 403 confirms the row exists, and a channel's existence is itself
 * information — "there is a #layoffs channel on this project" is worth knowing.
 */

/** What a caller is allowed to see of a conversation. */
export interface ConversationView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdByUserId: string;
  /** The concurrency token. A caller must present it to rename or archive. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ConversationMemberView {
  readonly userId: string;
  readonly joinedAt: string;
}

/** What a caller is allowed to see of a message. */
export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly parentMessageId: string | null;
  /**
   * `null` once the message has been moderated. The row survives and `deletedAt` records that
   * it was taken down, but the body does not come back out: the point of a removal is that
   * people stop reading it, and a projection that returned it with a flag would leave that to
   * whoever wrote the screen.
   */
  readonly body: string | null;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An explicit projection, not a serialised row — `25-AUTH-AND-TENANT-ISOLATION` §7: "Never
 * implement client access as `serializeInternalObject(); delete fields`." `organizationId`,
 * `nextSequenceNo`, `depth` and `parentDepth` are all absent: the first because the caller
 * already knows which organization they asked about, and the rest because they are how the
 * storage holds an invariant rather than facts about the channel.
 */
function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    createdByUserId: row.createdByUserId,
    version: Number(row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toMemberView(row: ConversationMembershipRow): ConversationMemberView {
  return { userId: row.userId, joinedAt: row.createdAt.toISOString() };
}

function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    authorUserId: row.authorUserId,
    sequenceNo: Number(row.sequenceNo),
    parentMessageId: row.parentMessageId,
    body: row.deletedAt === null ? row.body : null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    deletedByUserId: row.deletedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateConversationCommand {
  readonly projectId: string;
  readonly name: string;
}

export interface PostMessageCommand {
  readonly body: string;
  readonly parentMessageId?: string | null;
  readonly clientGeneratedId?: string | null;
}

export interface PostMessageResult {
  readonly message: MessageView;
  /** False when a client-generated id matched a message this author had already sent. */
  readonly created: boolean;
}

export class ConversationsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    /** Optional for the reason `WorkItemsService`'s is: a test can assert what is written. */
    private readonly audit?: AuditService,
    /**
     * Read-only, and used for one thing: proving the project a new channel names exists
     * **inside this tenant** before the insert is attempted. The composite foreign key already
     * refuses another tenant's project, but it surfaces as a 500, and a caller naming a project
     * id that is not theirs should get the same 404 as one naming an id that is not real.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * Read-only, and used for one thing: proving that somebody being *added* to a channel can
     * already reach the project it belongs to. See {@link ConversationsService.addMember}.
     */
    private readonly projectMemberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
  ) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  async list(
    context: TenantContext,
    principal: Principal,
    options: ListConversationsOptions = {},
  ): Promise<readonly ConversationView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.conversations.list(runner, context, options),
    );

    // Filtered rather than refused: a list is a list of what you may see. The per-row check is
    // `authorize()` plus conversation membership, exactly as `get` applies it.
    const visible: ConversationRow[] = [];
    for (const row of rows) {
      if (await this.mayReach(context, principal, row, 'conversation.read')) visible.push(row);
    }
    return visible.map(toConversationView);
  }

  async get(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationView> {
    const row = await this.loadReadable(context, principal, conversationId);
    return toConversationView(row);
  }

  /**
   * Create a channel on a project, and put its creator in it.
   *
   * One transaction for three writes: the channel, its first membership, and the audit row.
   * A channel whose creator is not a member of it would be a room nobody is in, and a second
   * request to fix that could fail — so it is not a second request.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    command: CreateConversationCommand,
  ): Promise<ConversationView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, command.projectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    this.requireProjectRelation(context, principal, command.projectId, 'conversation.write');

    const input: CreateConversationInput = {
      projectId: command.projectId,
      name: command.name,
      createdByUserId: context.userId,
    };

    const row = await this.database.transaction(context, async (tx) => {
      let created: ConversationRow;
      try {
        created = await this.conversations.create(tx, context, input);
      } catch (error) {
        if (error instanceof ConversationNameTakenError) {
          throw new ApiError(409, 'conflict', error.message);
        }
        throw error;
      }

      await this.conversations.addMember(tx, context, created.id, context.userId);

      await this.audit?.record(tx, context, {
        action: 'conversation.created',
        objectId: created.id,
        result: 'allowed',
        metadata: { project_id: created.projectId },
      });

      return created;
    });

    return toConversationView(row);
  }

  async rename(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    expectedVersion: number,
    name: string,
  ): Promise<ConversationView> {
    await this.loadWritable(context, principal, conversationId);

    const row = await this.database.transaction(context, async (tx) => {
      try {
        return await this.conversations.rename(tx, context, conversationId, expectedVersion, name);
      } catch (error) {
        throw this.translateConversationWriteError(error);
      }
    });

    return toConversationView(row);
  }

  async archive(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    expectedVersion: number,
  ): Promise<ConversationView> {
    await this.loadWritable(context, principal, conversationId);

    const row = await this.database.transaction(context, async (tx) => {
      try {
        return await this.conversations.archive(tx, context, conversationId, expectedVersion);
      } catch (error) {
        throw this.translateConversationWriteError(error);
      }
    });

    return toConversationView(row);
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  async listMembers(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<readonly ConversationMemberView[]> {
    await this.loadReadable(context, principal, conversationId);
    const rows = await this.database.read(context, (runner) =>
      this.conversations.listMembers(runner, context, conversationId),
    );
    return rows.map(toMemberView);
  }

  /**
   * Add somebody to a channel.
   *
   * The person being added must themselves be able to reach the project — otherwise a channel
   * membership would be a way to grant read access to a project the evaluator would refuse,
   * which is exactly the "policy may never silently widen" rule from §4. This service cannot
   * evaluate somebody else's principal, so it checks the fact the evaluator would have used:
   * an explicit `project_memberships` row, or organization-wide scope. That check lives in
   * `ProjectsRepository` and is the same read the principal assembly performs.
   */
  async addMember(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    userId: string,
  ): Promise<ConversationMemberView> {
    const conversation = await this.loadWritable(context, principal, conversationId);

    const related = await this.database.read(context, (runner) =>
      this.projectMemberships.findByProjectAndUser(runner, context, conversation.projectId, userId),
    );
    if (!related) {
      throw new ApiError(
        422,
        'validation_failed',
        'That person is not on this project, so they cannot be added to its channel',
        [{ field: 'userId', message: 'must be a member of the project this channel belongs to' }],
      );
    }

    const row = await this.database.transaction(context, async (tx) => {
      const membership = await this.conversations.addMember(tx, context, conversationId, userId);

      await this.audit?.record(tx, context, {
        action: 'conversation.member_added',
        objectId: conversationId,
        result: 'allowed',
        metadata: { target_user_id: userId, project_id: conversation.projectId },
      });

      return membership;
    });

    return toMemberView(row);
  }

  /** Returns nothing; a person who was not in the channel and now is not is not an error. */
  async removeMember(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const conversation = await this.loadWritable(context, principal, conversationId);

    await this.database.transaction(context, async (tx) => {
      const removed = await this.conversations.removeMember(tx, context, conversationId, userId);

      // The audit row is written only when something was actually revoked. A row for a no-op
      // would make the trail report removals that never happened, which is the reverse of the
      // failure §12 is worried about but is still a trail that cannot be relied on.
      if (removed) {
        await this.audit?.record(tx, context, {
          action: 'conversation.member_removed',
          objectId: conversationId,
          result: 'allowed',
          metadata: { target_user_id: userId, project_id: conversation.projectId },
        });
      }
    });
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async listMessages(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<readonly MessageView[]> {
    await this.loadReadable(context, principal, conversationId);
    const rows = await this.database.read(context, (runner) =>
      this.conversations.listMessages(runner, context, conversationId, options),
    );
    return rows.map(toMessageView);
  }

  /**
   * Post a message, or return the one this author already posted under the same client id.
   *
   * `23-ERD` §4 asks for retry dedupe on a client-generated id. The read below decides whether
   * the caller sees a 201 or the message they already sent; `uq_messages_client_generated` is
   * what actually guarantees there is only one, and the repository translates the collision
   * when two retries arrive at once.
   */
  async postMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    command: PostMessageCommand,
  ): Promise<PostMessageResult> {
    const conversation = await this.loadWritable(context, principal, conversationId);
    if (conversation.archivedAt !== null) {
      // `authorize()` already refuses a write against an archived resource; this repeats it
      // with a message a person can act on rather than a bare 404.
      throw new ApiError(409, 'conflict', 'This channel is archived, so nothing can be posted');
    }

    if (command.clientGeneratedId) {
      const existing = await this.database.read(context, (runner) =>
        this.conversations.findByClientGeneratedId(
          runner,
          context,
          context.userId,
          command.clientGeneratedId as string,
        ),
      );
      if (existing) return { message: toMessageView(existing), created: false };
    }

    const input: AppendMessageInput = {
      conversationId,
      authorUserId: context.userId,
      body: command.body,
      parentMessageId: command.parentMessageId ?? null,
      clientGeneratedId: command.clientGeneratedId ?? null,
    };

    const row = await this.database.transaction(context, async (tx) => {
      try {
        return await this.conversations.appendMessage(tx, context, input);
      } catch (error) {
        if (error instanceof InvalidThreadParentError) {
          // One message for "no such parent" and for "that parent is itself a reply". A caller
          // who could tell them apart could probe for messages in a thread they cannot read.
          throw new ApiError(422, 'validation_failed', 'That message cannot be replied to', [
            { field: 'parentMessageId', message: 'must be a top-level message in this channel' },
          ]);
        }
        if (error instanceof DuplicateMessageError) {
          throw new ApiError(409, 'conflict', 'That message has already been sent');
        }
        throw error;
      }
    });

    return { message: toMessageView(row), created: true };
  }

  /**
   * Edit a message. Only its author, and only while it is not taken down.
   *
   * `12-PERMISSION-MATRIX` §2's "Moderate messages: Own only" for Member and Guest is the row
   * this reads from: editing somebody else's words is not a capability anybody has, at any
   * role. A moderator can remove a message; nobody can rewrite one.
   */
  async editMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<MessageView> {
    await this.loadWritable(context, principal, conversationId);

    const existing = await this.database.read(context, (runner) =>
      this.conversations.findMessageById(runner, context, messageId),
    );
    if (!existing || existing.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (existing.authorUserId !== context.userId) {
      // 403 rather than 404: the caller can already read this message, so its existence is
      // not what is being protected. Telling them the truth is the more useful answer.
      throw new ApiError(403, 'forbidden', 'Only the person who wrote a message can edit it');
    }
    if (existing.deletedAt !== null) {
      throw new ApiError(409, 'conflict', 'This message was taken down and cannot be edited');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.conversations.editMessage(tx, context, messageId, body),
    );
    return toMessageView(row);
  }

  /**
   * Take a message down — `12-PERMISSION-MATRIX` §2 "Moderate messages".
   *
   * Two ways in, and the matrix draws both: `conversation.moderate` is the capability a
   * Manager or Moderator holds over a project, and "Own only" is every other role's — a person
   * may always take down their own message. The second is checked here rather than in the
   * evaluator because "is this your own row" is a fact about the row, which is what a service
   * is for.
   */
  async moderateMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<MessageView> {
    const conversation = await this.loadReadable(context, principal, conversationId);

    const existing = await this.database.read(context, (runner) =>
      this.conversations.findMessageById(runner, context, messageId),
    );
    if (!existing || existing.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const isOwn = existing.authorUserId === context.userId;
    const mayModerate = authorize({
      principal,
      capability: 'conversation.moderate',
      resource: {
        organizationId: context.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!isOwn && !mayModerate) {
      throw new ApiError(
        403,
        'forbidden',
        'You can take down your own messages; taking down somebody else’s needs moderation',
      );
    }

    const row = await this.database.transaction(context, async (tx) => {
      const moderated = await this.conversations.moderateMessage(
        tx,
        context,
        messageId,
        context.userId,
      );

      await this.audit?.record(tx, context, {
        action: 'message.deleted',
        objectId: messageId,
        result: 'allowed',
        metadata: {
          conversation_id: conversationId,
          project_id: conversation.projectId,
          // Not the body, and not who wrote it under a key the metadata gate would refuse.
          // `author_user_id` is an identifier, which is what §12 admits. `own_message` was
          // the first spelling of the flag below and it is **refused**: `message` is a
          // forbidden segment in `assertSafeAuditMetadata`, so the key that would have
          // described a moderation could not be written in a moderation's audit row. Found by
          // this ticket's own suite, as a 500 on every take-down.
          author_user_id: existing.authorUserId,
          actor_is_author: isOwn,
        },
      });

      return moderated;
    });

    return toMessageView(row);
  }

  // ── The two gates ──────────────────────────────────────────────────────────

  /**
   * Load a conversation this principal may read, or 404.
   *
   * An archived channel is readable and not writable, which is what `authorize()` step 6
   * already decides; this passes the real lifecycle so that decision is made there rather than
   * restated here.
   */
  private async loadReadable(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationRow> {
    const row = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!row || !(await this.mayReach(context, principal, row, 'conversation.read'))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /** Load a conversation this principal may write to, or 404. */
  private async loadWritable(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationRow> {
    const row = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!row || !(await this.mayReach(context, principal, row, 'conversation.write'))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /**
   * The evaluator, then conversation membership. Both must pass.
   *
   * The order is the whole of the rule: `authorize()` is authoritative and the membership
   * check can only narrow. Organization-wide scope skips the membership check for the reason
   * the evaluator skips the project-relation check for it — an Owner's access derives from
   * scope rather than from a row, and requiring one would mean an Owner could not read a
   * channel until somebody added them to it.
   */
  private async mayReach(
    context: TenantContext,
    principal: Principal,
    row: ConversationRow,
    capability: Extract<Capability, 'conversation.read' | 'conversation.write'>,
  ): Promise<boolean> {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: row.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) return false;

    if (principal.hasOrgWideScope) return true;

    const membership = await this.database.read(context, (runner) =>
      this.conversations.findMembership(runner, context, row.id, principal.userId),
    );
    return membership !== null;
  }

  /** The project relation, for an operation that has no conversation to check yet. */
  private requireProjectRelation(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Extract<Capability, 'conversation.write'>,
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });

    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }
  }

  /** A repository refusal, as the HTTP answer it means. */
  private translateConversationWriteError(error: unknown): unknown {
    if (error instanceof ConversationVersionConflictError) {
      return new ApiError(409, 'conflict', error.message);
    }
    if (error instanceof ConversationNameTakenError) {
      return new ApiError(409, 'conflict', error.message);
    }
    if (error instanceof ConversationNotFoundError || error instanceof MessageNotFoundError) {
      return new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return error;
  }
}
