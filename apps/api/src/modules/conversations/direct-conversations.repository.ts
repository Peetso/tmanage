import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { DirectParty } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import {
  clientMemberships,
  clientOrganizations,
  directConversations,
  directMessages,
  memberProfiles,
  memberships,
  messages,
  projectClients,
  projectMemberships,
  users,
} from '../../common/database/schema.js';
import type { DirectConversationRow, DirectMessageRow } from '../../common/database/schema.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * BK3 (COL-03) — the storage half of direct messages (`0214_direct_conversations.sql`).
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

const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

function isDuplicate(error: unknown, index: string): boolean {
  const unwrapped = unwrapQueryError(error) as { code?: unknown; sqlMessage?: unknown } | null;
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  if (unwrapped.code !== ER_DUP_ENTRY) return false;
  return typeof unwrapped.sqlMessage === 'string' && unwrapped.sqlMessage.includes(index);
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
 * state the API can read, so activity is a message the person posted here (a channel message or
 * a direct message) — tenant-scoped on purpose: the cross-tenant session rows would say the
 * person is active in some other studio, which is not this studio's business.
 */
export const ONLINE_WINDOW_MINUTES = 5;

export class DirectConversationsRepository {
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
    const postedDirectly = await db
      .selectDistinct({ userId: directMessages.authorUserId })
      .from(directMessages)
      .where(
        and(
          eq(directMessages.organizationId, context.organizationId),
          inArray(directMessages.authorUserId, ids),
          gt(directMessages.createdAt, recent),
        ),
      );

    const titleOf = new Map(titles.map((row) => [row.userId, row.jobTitle]));
    const companyOf = new Map<string, string>();
    for (const row of companies) {
      if (!companyOf.has(row.userId)) companyOf.set(row.userId, row.name);
    }
    const active = new Set([...postedInChannels, ...postedDirectly].map((row) => row.userId));
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

  async findPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    userLowId: string,
    userHighId: string,
  ): Promise<DirectConversationRow | null> {
    const [row] = await tenantDrizzle(runner)
      .select()
      .from(directConversations)
      .where(
        and(
          eq(directConversations.organizationId, context.organizationId),
          eq(directConversations.userLowId, userLowId),
          eq(directConversations.userHighId, userHighId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<DirectConversationRow | null> {
    const [row] = await tenantDrizzle(runner)
      .select()
      .from(directConversations)
      .where(
        and(
          eq(directConversations.organizationId, context.organizationId),
          eq(directConversations.id, id),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert the pair, or return the row a concurrent opener just inserted. `created` says which.
   */
  async insertPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    userLowId: string,
    userHighId: string,
  ): Promise<{ readonly row: DirectConversationRow; readonly created: boolean }> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(directConversations)
        .values({
          id,
          organizationId: context.organizationId,
          userLowId,
          userHighId,
          createdByUserId: context.userId,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (!isDuplicate(error, 'uq_direct_conversations_pair')) throw error;
      const existing = await this.findPair(runner, context, userLowId, userHighId);
      if (!existing) throw error;
      return { row: existing, created: false };
    }
    const row = await this.findById(runner, context, id);
    if (!row) throw new Error('direct conversation vanished immediately after insert');
    return { row, created: true };
  }

  /** The caller's direct conversations, most recent activity first. */
  async listForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    limit: number,
  ): Promise<readonly DirectConversationRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(directConversations)
      .where(
        and(
          eq(directConversations.organizationId, context.organizationId),
          or(eq(directConversations.userLowId, userId), eq(directConversations.userHighId, userId)),
        ),
      )
      .orderBy(desc(directConversations.updatedAt), desc(directConversations.id))
      .limit(limit);
  }

  async listMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    afterSequenceNo: number,
    limit: number,
  ): Promise<readonly DirectMessageRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(directMessages)
      .where(
        and(
          eq(directMessages.organizationId, context.organizationId),
          eq(directMessages.directConversationId, directConversationId),
          gt(directMessages.sequenceNo, afterSequenceNo),
        ),
      )
      .orderBy(asc(directMessages.sequenceNo))
      .limit(limit);
  }

  /** The dedupe read, scoped to the destination conversation (see `ConversationsRepository`). */
  async findByClientGeneratedId(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    authorUserId: string,
    clientGeneratedId: string,
  ): Promise<DirectMessageRow | null> {
    const [row] = await tenantDrizzle(runner)
      .select()
      .from(directMessages)
      .where(
        and(
          eq(directMessages.organizationId, context.organizationId),
          eq(directMessages.directConversationId, directConversationId),
          eq(directMessages.authorUserId, authorUserId),
          eq(directMessages.clientGeneratedId, clientGeneratedId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * 0216: move one participant's read marker forward to `upTo`, never backwards and never past
   * the allocator's last handed-out number. `updated_at = updated_at` keeps the activity order
   * of the list unchanged by a read. The side is the service's to name from the row it loaded.
   */
  async markRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    side: 'low' | 'high',
    upTo: number,
  ): Promise<void> {
    const column =
      side === 'low' ? 'user_low_last_read_sequence_no' : 'user_high_last_read_sequence_no';
    const userColumn = side === 'low' ? 'user_low_id' : 'user_high_id';
    await runner.execute(
      `update direct_conversations
          set ${column} = least(greatest(${column}, ?), next_sequence_no - 1),
              updated_at = updated_at
        where organization_id = ? and id = ? and ${userColumn} = ?`,
      [upTo, context.organizationId, directConversationId, context.userId],
    );
  }

  /** Append under the pair row's lock: read the allocator, bump it, insert. */
  async appendMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly directConversationId: string;
      readonly body: string;
      readonly clientGeneratedId: string | null;
    },
  ): Promise<DirectMessageRow> {
    const locked = await runner.execute<QueryRows>(
      `select next_sequence_no from direct_conversations
        where organization_id = ? and id = ?
        for update`,
      [context.organizationId, input.directConversationId],
    );
    const sequenceNo = locked[0]?.['next_sequence_no'] as number | undefined;
    if (sequenceNo === undefined) throw new Error('direct conversation not found');

    // 0216: posting is reading — the author's own marker moves to the message they send, so
    // every message past a participant's marker is from the other person (the unread count).
    await runner.execute(
      `update direct_conversations
          set next_sequence_no = next_sequence_no + 1, last_message_at = current_timestamp(3),
              user_low_last_read_sequence_no = case when user_low_id = ?
                then greatest(user_low_last_read_sequence_no, ?)
                else user_low_last_read_sequence_no end,
              user_high_last_read_sequence_no = case when user_high_id = ?
                then greatest(user_high_last_read_sequence_no, ?)
                else user_high_last_read_sequence_no end
        where organization_id = ? and id = ?`,
      [
        context.userId,
        Number(sequenceNo),
        context.userId,
        Number(sequenceNo),
        context.organizationId,
        input.directConversationId,
      ],
    );

    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(directMessages)
        .values({
          id,
          organizationId: context.organizationId,
          directConversationId: input.directConversationId,
          authorUserId: context.userId,
          sequenceNo: Number(sequenceNo),
          body: input.body,
          clientGeneratedId: input.clientGeneratedId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicate(error, 'uq_direct_messages_client_generated')) {
        throw new DuplicateDirectMessageError();
      }
      throw error;
    }

    const [row] = await tenantDrizzle(runner)
      .select()
      .from(directMessages)
      .where(
        and(eq(directMessages.organizationId, context.organizationId), eq(directMessages.id, id)),
      )
      .limit(1);
    if (!row) throw new Error('direct message vanished immediately after insert');
    return row;
  }
}
