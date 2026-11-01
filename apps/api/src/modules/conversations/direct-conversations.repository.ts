import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { DirectParty } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  clientOrganizations,
  conversationReadState,
  conversations,
  memberProfiles,
  memberships,
  messages,
  projectClients,
  projectMemberships,
  users,
} from '../../common/database/schema.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import {
  ConversationsRepository,
  DirectPairTakenError,
  DuplicateMessageError,
} from './conversations.repository.js';
import { ConversationReadStateRepository, memberReader } from './read-state.repository.js';

/**
 * BK3 (COL-03) — the storage half of direct messages. R7 slice 1 (0276): a direct conversation
 * is a `conversations` row with `kind = 'direct'` and its sorted pair, its messages are ordinary
 * `messages` rows, and each person's read marker is their `conversation_read_state` row. The old
 * `direct_conversations` / `direct_messages` tables are read by nothing any more.
 *
 * Every query is anchored on `context.organizationId`. The relation rule (who may talk to whom)
 * is the service's; this file only answers the facts it needs: what kind of member a user is in
 * this tenant and which projects they reach, and the pair / message rows themselves.
 */

/** A participant as the relation rule sees them — the shared domain shape (worker uses it too). */
export type { DirectParty } from '@tmanage/domain';

export class DuplicateDirectMessageError extends Error {
  constructor() {
    super('direct message client id already used');
    this.name = 'DuplicateDirectMessageError';
  }
}

/**
 * The pre-R7 `direct_conversations` row shape, kept so the service and DirectMessageScreen keep
 * working until R7 slice 2 retires the DM endpoints. Each side's read position is derived.
 */
export interface DirectThreadRow {
  readonly id: string;
  readonly userLowId: string;
  readonly userHighId: string;
  readonly nextSequenceNo: number;
  readonly userLowLastReadSequenceNo: number;
  readonly userHighLastReadSequenceNo: number;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The pre-R7 `direct_messages` row shape, read from `messages`. */
export interface DirectThreadMessageRow {
  readonly id: string;
  readonly directConversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * C5 — what a DM header and list say about the other person, beyond the name: their job title in
 * this studio (0215), the client company they belong to (client people only), and whether they
 * did something here in the last {@link ONLINE_WINDOW_MINUTES} minutes.
 */
export interface DirectParticipantDetails {
  readonly displayName: string | null;
  readonly jobTitle: string | null;
  readonly clientCompanyName: string | null;
  readonly online: boolean;
}

/**
 * "Online" means activity in this studio within this many minutes. There is no presence socket
 * state the API can read, so activity is a message the person posted here (any conversation,
 * direct ones included since R7) — tenant-scoped on purpose: the cross-tenant session rows would say the
 * person is active in some other studio, which is not this studio's business.
 */
export const ONLINE_WINDOW_MINUTES = 5;

export class DirectConversationsRepository {
  constructor(
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly readState: ConversationReadStateRepository = new ConversationReadStateRepository(),
  ) {}

  /** What kind of active member `userId` is in this tenant, and which projects they reach. */
  async findParty(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<DirectParty | null> {
    const db = tenantDrizzle(runner);
    const internal = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (internal.length > 0) {
      const projects = await db
        .select({ projectId: projectMemberships.projectId })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.organizationId, context.organizationId),
            eq(projectMemberships.userId, userId),
          ),
        );
      return {
        userId,
        kind: 'internal',
        clientOrganizationIds: [],
        projectIds: projects.map((row) => row.projectId),
      };
    }

    const clients = await db
      .select({ clientOrganizationId: clientMemberships.clientOrganizationId })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.userId, userId),
          eq(clientMemberships.status, 'active'),
          or(
            isNull(clientMemberships.expiresAt),
            gt(clientMemberships.expiresAt, sql`current_timestamp(3)`),
          ),
        ),
      );
    if (clients.length === 0) return null;
    const clientOrganizationIds = clients.map((row) => row.clientOrganizationId);
    const projects = await db
      .select({ projectId: projectClients.projectId })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          inArray(projectClients.clientOrganizationId, clientOrganizationIds),
        ),
      );
    return {
      userId,
      kind: 'client',
      clientOrganizationIds,
      projectIds: projects.map((row) => row.projectId),
    };
  }

  /** Display names for a set of users (the global `users` table; ids only, never emails). */
  async displayNames(
    runner: TenantQueryRunner,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /** C5: name, job title, client company and recent activity for each of `userIds`. */
  async participantDetails(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, DirectParticipantDetails>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const db = tenantDrizzle(runner);
    const recent = sql`current_timestamp(3) - interval ${ONLINE_WINDOW_MINUTES} minute`;

    const names = await this.displayNames(runner, ids);
    const titles = await db
      .select({ userId: memberProfiles.userId, jobTitle: memberProfiles.jobTitle })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.organizationId, context.organizationId),
          inArray(memberProfiles.userId, ids),
        ),
      );
    const companies = await db
      .select({ userId: clientMemberships.userId, name: clientOrganizations.name })
      .from(clientMemberships)
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.userId, ids),
          eq(clientMemberships.status, 'active'),
          or(
            isNull(clientMemberships.expiresAt),
            gt(clientMemberships.expiresAt, sql`current_timestamp(3)`),
          ),
        ),
      )
      .orderBy(asc(clientOrganizations.name));
    const postedInChannels = await db
      .selectDistinct({ userId: messages.authorUserId })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          inArray(messages.authorUserId, ids),
          gt(messages.createdAt, recent),
        ),
      );

    const titleOf = new Map(titles.map((row) => [row.userId, row.jobTitle]));
    const companyOf = new Map<string, string>();
    for (const row of companies) {
      if (!companyOf.has(row.userId)) companyOf.set(row.userId, row.name);
    }
    const active = new Set(postedInChannels.map((row) => row.userId));
    return new Map(
      ids.map((id) => [
        id,
        {
          displayName: names.get(id) ?? null,
          jobTitle: titleOf.get(id) ?? null,
          clientCompanyName: companyOf.get(id) ?? null,
          online: active.has(id),
        },
      ]),
    );
  }

  /** R7: the direct conversation for a sorted pair (`uq_conversations_direct_pair`). */
  async findPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    userLowId: string,
    userHighId: string,
  ): Promise<DirectThreadRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.kind, 'direct'),
          eq(conversations.directUserLowId, userLowId),
          eq(conversations.directUserHighId, userHighId),
        ),
      )
      .limit(1);
    return (await this.toThreads(runner, context, rows))[0] ?? null;
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<DirectThreadRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.kind, 'direct'),
          eq(conversations.id, id),
        ),
      )
      .limit(1);
    return (await this.toThreads(runner, context, rows))[0] ?? null;
  }

  /**
   * Insert the pair as a `kind = 'direct'` conversation with both people as members, or return
   * the row a concurrent opener just inserted. `created` says which.
   */
  async insertPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    userLowId: string,
    userHighId: string,
  ): Promise<{ readonly row: DirectThreadRow; readonly created: boolean }> {
    const id = uuidv7();
    try {
      await this.conversations.create(runner, context, {
        id,
        kind: 'direct',
        projectId: null,
        directUserLowId: userLowId,
        directUserHighId: userHighId,
        // Never shown; it keeps the column non-empty and unique (0276 uses the same form).
        name: `dm:${id}`,
        createdByUserId: context.userId,
      });
    } catch (error) {
      if (!(error instanceof DirectPairTakenError)) throw error;
      const existing = await this.findPair(runner, context, userLowId, userHighId);
      if (!existing) throw error;
      return { row: existing, created: false };
    }
    await this.conversations.addMember(runner, context, id, userLowId);
    await this.conversations.addMember(runner, context, id, userHighId);
    const row = await this.findById(runner, context, id);
    if (!row) throw new Error('direct conversation vanished immediately after insert');
    return { row, created: true };
  }

  /** The caller's direct conversations, most recent activity first; archived ones leave. */
  async listForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    limit: number,
  ): Promise<readonly DirectThreadRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.kind, 'direct'),
          or(eq(conversations.directUserLowId, userId), eq(conversations.directUserHighId, userId)),
          isNull(conversations.archivedAt),
        ),
      )
      .orderBy(
        desc(conversations.lastMessageAt),
        desc(conversations.updatedAt),
        desc(conversations.id),
      )
      .limit(limit);
    return this.toThreads(runner, context, rows);
  }

  async listMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    afterSequenceNo: number,
    limit: number,
  ): Promise<readonly DirectThreadMessageRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, directConversationId),
          gt(messages.sequenceNo, afterSequenceNo),
          // PA-03 (0245): a soft-deleted message leaves the list.
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(asc(messages.sequenceNo))
      .limit(limit);
    return rows.map(toThreadMessage);
  }

  /** The dedupe read, scoped to the destination conversation (see `ConversationsRepository`). */
  async findByClientGeneratedId(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    authorUserId: string,
    clientGeneratedId: string,
  ): Promise<DirectThreadMessageRow | null> {
    const row = await this.conversations.findByClientGeneratedId(
      runner,
      context,
      directConversationId,
      authorUserId,
      clientGeneratedId,
    );
    return row ? toThreadMessage(row) : null;
  }

  /**
   * Move the caller's read marker forward to the newest message at or before `upTo`, never
   * backwards. R7: the marker is the caller's `conversation_read_state` row, keyed by their
   * internal membership; a client person has no such row, so nothing is stored for them (their
   * position reads as fully read; R7 slice 6 gives client members a read marker).
   */
  async markRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    upTo: number,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const [membership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, context.userId),
        ),
      )
      .limit(1);
    if (!membership) return;
    const [target] = await db
      .select({ id: messages.id, sequenceNo: messages.sequenceNo })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, directConversationId),
          lte(messages.sequenceNo, upTo),
        ),
      )
      .orderBy(desc(messages.sequenceNo))
      .limit(1);
    if (!target) return;
    const positions = await this.readPositions(runner, context, [directConversationId]);
    const current = positions.get(`${directConversationId}:${context.userId}`) ?? 0;
    if (Number(target.sequenceNo) <= current) return;
    await this.readState.upsert(
      runner,
      context,
      directConversationId,
      memberReader(membership.id),
      target.id,
    );
  }

  /**
   * Append through the one message path (`ConversationsRepository.appendMessage`: the allocator
   * lock, `last_message_id/at`), then mark the author read — posting is reading, so every message
   * past a participant's marker is from the other person (the unread count).
   */
  async appendMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly directConversationId: string;
      readonly body: string;
      readonly clientGeneratedId: string | null;
    },
  ): Promise<DirectThreadMessageRow> {
    let row: MessageRow;
    try {
      row = await this.conversations.appendMessage(runner, context, {
        conversationId: input.directConversationId,
        authorUserId: context.userId,
        body: input.body,
        clientGeneratedId: input.clientGeneratedId,
      });
    } catch (error) {
      if (error instanceof DuplicateMessageError) throw new DuplicateDirectMessageError();
      throw error;
    }
    await this.markRead(runner, context, input.directConversationId, Number(row.sequenceNo));
    return toThreadMessage(row);
  }

  /**
   * `conversationId:userId → last-read sequence number` for internal people with a read-state
   * row in `conversationIds` (the marker joins its message for the number).
   */
  private async readPositions(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({
        conversationId: conversationReadState.conversationId,
        userId: memberships.userId,
        sequenceNo: messages.sequenceNo,
      })
      .from(conversationReadState)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, conversationReadState.organizationId),
          eq(memberships.id, conversationReadState.membershipId),
        ),
      )
      .innerJoin(
        messages,
        and(
          eq(messages.organizationId, conversationReadState.organizationId),
          eq(messages.id, conversationReadState.lastReadMessageId),
        ),
      )
      .where(
        and(
          eq(conversationReadState.organizationId, context.organizationId),
          inArray(conversationReadState.conversationId, [...conversationIds]),
        ),
      );
    return new Map(
      rows.map((row) => [`${row.conversationId}:${row.userId}`, Number(row.sequenceNo)]),
    );
  }

  /** The thread shape of `kind = 'direct'` rows: the pair and each side's read position. */
  private async toThreads(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly ConversationRow[],
  ): Promise<readonly DirectThreadRow[]> {
    if (rows.length === 0) return [];
    const positions = await this.readPositions(
      runner,
      context,
      rows.map((row) => row.id),
    );
    const people = [
      ...new Set(rows.flatMap((row) => [row.directUserLowId, row.directUserHighId])),
    ].filter((id): id is string => id !== null);
    const internal = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.userId, people),
        ),
      );
    const hasMarker = new Set(internal.map((row) => row.userId));
    return rows.map((row) => {
      const low = row.directUserLowId ?? '';
      const high = row.directUserHighId ?? '';
      const last = Math.max(0, Number(row.nextSequenceNo) - 1);
      const marker = (userId: string) =>
        hasMarker.has(userId) ? (positions.get(`${row.id}:${userId}`) ?? 0) : last;
      return {
        id: row.id,
        userLowId: low,
        userHighId: high,
        nextSequenceNo: Number(row.nextSequenceNo),
        userLowLastReadSequenceNo: marker(low),
        userHighLastReadSequenceNo: marker(high),
        lastMessageAt: row.lastMessageAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }
}

function toThreadMessage(row: MessageRow): DirectThreadMessageRow {
  return {
    id: row.id,
    directConversationId: row.conversationId,
    authorUserId: row.authorUserId,
    sequenceNo: Number(row.sequenceNo),
    body: row.body,
    createdAt: row.createdAt,
  };
}
