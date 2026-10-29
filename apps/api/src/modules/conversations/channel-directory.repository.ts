import { and, eq, gt, inArray, isNull, max, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  conversationMemberships,
  messages,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** One member of one channel, with the name the avatar's initials come from. */
export interface ChannelMemberFact {
  readonly conversationId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly joinedAt: Date;
}

/** What the channel browser needs beyond the conversation rows themselves. */
export interface ChannelDirectoryFacts {
  /** Newest message per conversation; a channel with no message is absent. */
  readonly lastMessageAt: ReadonlyMap<string, Date>;
  readonly members: readonly ChannelMemberFact[];
  /** Members who hold a live client membership in this organization. */
  readonly clientUserIds: ReadonlySet<string>;
}

/**
 * The channel browser's read side (CH-01): last activity, members and which of them are clients.
 *
 * Three tenant-scoped reads over ids the service has already filtered to what the caller may
 * reach, so nothing here widens visibility. `now` is a bound value rather than the server's clock
 * for the reason the admin pool's session time zone is not the application's.
 */
export class ChannelDirectoryRepository {
  async facts(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationIds: readonly string[],
    now: Date,
  ): Promise<ChannelDirectoryFacts> {
    if (conversationIds.length === 0) {
      return { lastMessageAt: new Map(), members: [], clientUserIds: new Set() };
    }
    const db = tenantDrizzle(runner);
    const ids = [...conversationIds];

    const activity = await db
      .select({ conversationId: messages.conversationId, last: max(messages.createdAt) })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          inArray(messages.conversationId, ids),
          // PA-03 (0245): a soft-deleted message is not counted.
          isNull(messages.deletedAt),
        ),
      )
      .groupBy(messages.conversationId);

    const members = await db
      .select({
        conversationId: conversationMemberships.conversationId,
        userId: conversationMemberships.userId,
        displayName: users.displayName,
        joinedAt: conversationMemberships.createdAt,
      })
      .from(conversationMemberships)
      .innerJoin(users, eq(users.id, conversationMemberships.userId))
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          inArray(conversationMemberships.conversationId, ids),
        ),
      );

    const memberIds = [...new Set(members.map((member) => member.userId))];
    const clients =
      memberIds.length === 0
        ? []
        : await db
            .select({ userId: clientMemberships.userId })
            .from(clientMemberships)
            .where(
              and(
                eq(clientMemberships.organizationId, context.organizationId),
                inArray(clientMemberships.userId, memberIds),
                eq(clientMemberships.status, 'active'),
                or(isNull(clientMemberships.expiresAt), gt(clientMemberships.expiresAt, now)),
              ),
            );

    const lastMessageAt = new Map<string, Date>();
    for (const row of activity) {
      if (row.last) lastMessageAt.set(row.conversationId, new Date(row.last));
    }
    return {
      lastMessageAt,
      members,
      clientUserIds: new Set(clients.map((row) => row.userId)),
    };
  }
}
