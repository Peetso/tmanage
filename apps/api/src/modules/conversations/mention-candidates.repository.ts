import { and, asc, eq, like, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationMemberships, memberships, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * BK3 (COL-02) — who can be @mentioned in a channel: the people who can read it, which is
 * exactly who the worker's `planMentionNotices` will notify — active internal members who are in
 * the channel, plus active internal members with organization-wide scope (an Owner reads every
 * channel without a membership row). Prefix match on the display name or any word in it.
 */
export interface MentionCandidateRow {
  readonly userId: string;
  readonly displayName: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function namePrefix(prefix: string) {
  const escaped = escapeLike(prefix);
  return or(like(users.displayName, `${escaped}%`), like(users.displayName, `% ${escaped}%`));
}

export class MentionCandidatesRepository {
  async search(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    prefix: string,
    limit: number,
  ): Promise<readonly MentionCandidateRow[]> {
    const db = tenantDrizzle(runner);
    const nameFilter = prefix === '' ? undefined : namePrefix(prefix);

    const inChannel = await db
      .select({ userId: users.id, displayName: users.displayName })
      .from(conversationMemberships)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, conversationMemberships.organizationId),
          eq(memberships.userId, conversationMemberships.userId),
        ),
      )
      .innerJoin(users, eq(users.id, conversationMemberships.userId))
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(memberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
          eq(memberships.status, 'active'),
          nameFilter,
        ),
      )
      .orderBy(asc(users.displayName))
      .limit(limit);

    const orgWide = await db
      .select({ userId: users.id, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          eq(memberships.hasOrgWideScope, true),
          nameFilter,
        ),
      )
      .orderBy(asc(users.displayName))
      .limit(limit);

    return [...inChannel, ...orgWide];
  }
}
