import { hasCapability, mayDirectMessage } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DirectConversationRow, DirectMessageRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { DuplicateDirectMessageError } from './direct-conversations.repository.js';
import type {
  DirectConversationsRepository,
  DirectParticipantDetails,
} from './direct-conversations.repository.js';

/** The relation rule now lives in `@tmanage/domain` so the worker applies the same one. */
export { mayDirectMessage };

/**
 * BK3 (COL-03) — one-to-one direct messages between two members of one studio.
 *
 * ## Who may talk to whom
 *
 * {@link mayDirectMessage} is the whole rule, and it is applied on every call — create, list,
 * read and post — so a relation that ends (a project unshared, a membership suspended) closes the
 * conversation for both people without deleting anything:
 *
 * - two internal members: always;
 * - a client person and an internal member: only if they share a project (the internal member's
 *   `project_memberships` meets the projects shared with the client's organization);
 * - two client people: only within the same client organization. Two client organizations of one
 *   tenant never see each other (`04-SECURITY-PRIVACY` §5).
 *
 * An internal caller additionally needs `conversation.read` to read and `conversation.write` to
 * open or post (a guest reads, does not originate). A client role holds no conversation
 * capability; the relation rule is its gate. Every refusal is a 404 that does not say whether the
 * person or the conversation exists.
 */

export interface DirectConversationView {
  readonly id: string;
  readonly otherUserId: string;
  readonly otherDisplayName: string | null;
  /** C5: the other person's job title in this studio (0215), or null when they set none. */
  readonly otherJobTitle: string | null;
  /** C5: the client company the other person belongs to — client people only, else null. */
  readonly otherClientCompanyName: string | null;
  /** C5: whether the other person posted anything in this studio in the last five minutes. */
  readonly otherOnline: boolean;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
  /** The last sequence number handed out in this conversation (0 before the first message). */
  readonly lastSequenceNo: number;
  /** The caller's own last-read sequence number (0216). */
  readonly lastReadSequenceNo: number;
  /** Messages past the caller's marker — all from the other person (posting marks read). */
  readonly unreadCount: number;
}

/** The caller's read position in one direct conversation, after a mark-read (0216). */
export interface DirectReadStateView {
  readonly directConversationId: string;
  readonly lastSequenceNo: number;
  readonly lastReadSequenceNo: number;
  readonly unreadCount: number;
}

export interface DirectMessageView {
  readonly id: string;
  readonly directConversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly body: string;
  readonly createdAt: string;
}

const LIST_LIMIT = 100;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function sortedPair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

function otherOf(row: DirectConversationRow, userId: string): string | null {
  if (row.userLowId === userId) return row.userHighId;
  if (row.userHighId === userId) return row.userLowId;
  return null;
}

/** The caller's position in `row`: last handed-out number, own marker, and the gap between. */
export function readPositionOf(
  row: DirectConversationRow,
  userId: string,
): {
  readonly lastSequenceNo: number;
  readonly lastReadSequenceNo: number;
  readonly unreadCount: number;
} {
  const lastSequenceNo = Math.max(0, Number(row.nextSequenceNo) - 1);
  const marker =
    row.userLowId === userId
      ? Number(row.userLowLastReadSequenceNo)
      : row.userHighId === userId
        ? Number(row.userHighLastReadSequenceNo)
        : lastSequenceNo;
  const lastReadSequenceNo = Math.min(marker, lastSequenceNo);
  return { lastSequenceNo, lastReadSequenceNo, unreadCount: lastSequenceNo - lastReadSequenceNo };
}

function toMessageView(row: DirectMessageRow): DirectMessageView {
  return {
    id: row.id,
    directConversationId: row.directConversationId,
    authorUserId: row.authorUserId,
    sequenceNo: Number(row.sequenceNo),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DirectConversationsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: DirectConversationsRepository,
    /** BK3-left: `direct_message.created.v1` for the socket fan-out and the recipient's notice. */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  /** Create-or-get the conversation with `otherUserId`. `created` is false for an existing one. */
  async open(
    context: TenantContext,
    principal: Principal,
    otherUserId: string,
  ): Promise<{ readonly conversation: DirectConversationView; readonly created: boolean }> {
    this.requireInternalCapability(principal, 'write');
    if (otherUserId === context.userId) {
      throw new ApiError(422, 'validation_failed', 'You cannot message yourself', [
        { field: 'userId', message: 'must be another member' },
      ]);
    }
    await this.requireRelation(context, otherUserId);

    const [low, high] = sortedPair(context.userId, otherUserId);
    const result = await this.database.transaction(context, async (tx) => {
      const existing = await this.repository.findPair(tx, context, low, high);
      if (existing) return { row: existing, created: false };
      return this.repository.insertPair(tx, context, low, high);
    });
    const details = await this.database.read(context, (runner) =>
      this.repository.participantDetails(runner, context, [otherUserId]),
    );
    return {
      conversation: this.toView(result.row, context.userId, details),
      created: result.created,
    };
  }

  /** The caller's direct conversations whose relation still holds, most recent first. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly DirectConversationView[]> {
    this.requireInternalCapability(principal, 'read');
    return this.database.read(context, async (runner) => {
      const rows = await this.repository.listForUser(runner, context, context.userId, LIST_LIMIT);
      const me = await this.repository.findParty(runner, context, context.userId);
      const visible: DirectConversationRow[] = [];
      for (const row of rows) {
        const other = otherOf(row, context.userId);
        if (other === null) continue;
        const party = await this.repository.findParty(runner, context, other);
        if (mayDirectMessage(me, party)) visible.push(row);
      }
      const details = await this.repository.participantDetails(
        runner,
        context,
        visible.map((row) => otherOf(row, context.userId) as string),
      );
      return visible.map((row) => this.toView(row, context.userId, details));
    });
  }

  async listMessages(
    context: TenantContext,
    principal: Principal,
    directConversationId: string,
    options: { readonly afterSequenceNo?: number; readonly limit?: number } = {},
  ): Promise<readonly DirectMessageView[]> {
    this.requireInternalCapability(principal, 'read');
    await this.loadReachable(context, directConversationId);
    const limit = Math.min(options.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const rows = await this.database.read(context, (runner) =>
      this.repository.listMessages(
        runner,
        context,
        directConversationId,
        options.afterSequenceNo ?? 0,
        limit,
      ),
    );
    return rows.map(toMessageView);
  }

  /** Post a message. `created` is false for a deduplicated retry (same clientGeneratedId). */
  async post(
    context: TenantContext,
    principal: Principal,
    directConversationId: string,
    command: { readonly body: string; readonly clientGeneratedId?: string },
  ): Promise<{ readonly message: DirectMessageView; readonly created: boolean }> {
    this.requireInternalCapability(principal, 'write');
    const conversation = await this.loadReachable(context, directConversationId);

    if (command.clientGeneratedId !== undefined) {
      const clientGeneratedId = command.clientGeneratedId;
      const existing = await this.database.read(context, (runner) =>
        this.repository.findByClientGeneratedId(
          runner,
          context,
          directConversationId,
          context.userId,
          clientGeneratedId,
        ),
      );
      if (existing) return { message: toMessageView(existing), created: false };
    }

    const recipientUserId = otherOf(conversation, context.userId) as string;
    try {
      const row = await this.database.transaction(context, async (tx) => {
        const appended = await this.repository.appendMessage(tx, context, {
          directConversationId,
          body: command.body,
          clientGeneratedId: command.clientGeneratedId ?? null,
        });
        // Ids only, committed with the message (§2). The worker publishes the socket frame on
        // this conversation and tells the recipient, after re-checking the relation (§6).
        await this.outbox?.append(tx, context, {
          type: 'direct_message.created.v1',
          aggregateId: directConversationId,
          payload: {
            directConversationId,
            messageId: appended.id,
            sequenceNo: Number(appended.sequenceNo),
            authorUserId: context.userId,
            recipientUserId,
          },
        });
        return appended;
      });
      return { message: toMessageView(row), created: true };
    } catch (error) {
      if (error instanceof DuplicateDirectMessageError) {
        throw new ApiError(409, 'conflict', 'That message has already been sent');
      }
      throw error;
    }
  }

  /**
   * 0216: move the caller's read marker forward — to `upToSequenceNo`, or to the latest message
   * when omitted. Never backwards, never past the last message; a reader's act, so `read` mode.
   */
  async markRead(
    context: TenantContext,
    principal: Principal,
    directConversationId: string,
    upToSequenceNo?: number,
  ): Promise<DirectReadStateView> {
    this.requireInternalCapability(principal, 'read');
    const row = await this.loadReachable(context, directConversationId);
    const side = row.userLowId === context.userId ? 'low' : 'high';
    const upTo = upToSequenceNo ?? Number.MAX_SAFE_INTEGER;
    const updated = await this.database.transaction(context, async (tx) => {
      await this.repository.markRead(tx, context, directConversationId, side, upTo);
      return this.repository.findById(tx, context, directConversationId);
    });
    return { directConversationId, ...readPositionOf(updated ?? row, context.userId) };
  }

  private requireInternalCapability(principal: Principal, mode: 'read' | 'write'): void {
    if (principal.kind !== 'internal') return; // clients: the relation rule is the gate
    const capability = mode === 'read' ? 'conversation.read' : 'conversation.write';
    if (!hasCapability(principal.role, capability)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  private async requireRelation(context: TenantContext, otherUserId: string): Promise<void> {
    const allowed = await this.database.read(context, async (runner) =>
      mayDirectMessage(
        await this.repository.findParty(runner, context, context.userId),
        await this.repository.findParty(runner, context, otherUserId),
      ),
    );
    if (!allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /** The conversation, if the caller is in it and the relation still holds; otherwise 404. */
  private async loadReachable(
    context: TenantContext,
    directConversationId: string,
  ): Promise<DirectConversationRow> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findById(runner, context, directConversationId),
    );
    const other = row ? otherOf(row, context.userId) : null;
    if (!row || other === null) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    await this.requireRelation(context, other);
    return row;
  }

  private toView(
    row: DirectConversationRow,
    userId: string,
    details: ReadonlyMap<string, DirectParticipantDetails>,
  ): DirectConversationView {
    const other = otherOf(row, userId) as string;
    const about = details.get(other);
    return {
      id: row.id,
      otherUserId: other,
      otherDisplayName: about?.displayName ?? null,
      otherJobTitle: about?.jobTitle ?? null,
      otherClientCompanyName: about?.clientCompanyName ?? null,
      otherOnline: about?.online ?? false,
      lastMessageAt: row.lastMessageAt === null ? null : row.lastMessageAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      ...readPositionOf(row, userId),
    };
  }
}
