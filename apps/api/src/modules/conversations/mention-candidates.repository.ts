import { and, asc, eq, like, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  conversationMemberships,
  conversations,
  memberships,
  projectMemberships,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * BK3 (COL-02) — who can be @mentioned in a channel: the people who can read it, which is
 * exactly who the worker's `planMentionNotices` will notify — active internal members who are in
 * the channel, plus active internal members with organization-wide scope (an Owner reads every
 * channel without a membership row). Prefix match on the display name or any word in it.
 *
 * F13: a channel row alone is not a read relation — a person removed from the channel's project
 * may still hold one from before the removal — so the in-channel half also requires a current
 * `project_memberships` row on the channel's project. Org-wide members come from the second half.
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
      .innerJoin(
        conversations,
        and(
          eq(conversations.organizationId, conversationMemberships.organizationId),
          eq(conversations.id, conversationMemberships.conversationId),
        ),
      )
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.organizationId, conversations.organizationId),
          eq(projectMemberships.projectId, conversations.projectId),
          eq(projectMemberships.userId, conversationMemberships.userId),
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
