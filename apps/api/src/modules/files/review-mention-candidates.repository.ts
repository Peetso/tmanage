import { and, asc, eq, inArray, like, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  memberships,
  projectClients,
  projectMemberships,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R4 slice 5 — the people a proofing comment may @mention, and the names shown on a thread.
 *
 * - **Staff on the project**: active internal members with a `project_memberships` row on the
 *   project, plus active members with organization-wide scope (an Owner reads every project
 *   without a row) — the BK3 channel picker's two halves, minus the hidden Support role.
 * - **Client contacts**: active `client_memberships` of the client organizations linked to the
 *   project (`project_clients`), optionally only one client organization (the client door: a
 *   client may name the studio's people and their own colleagues, never another client's).
 *
 * The mention token is `@<userId>`, the form `extractMentionedUserIds` reads.
 */

export type ReviewPersonKind = 'internal' | 'client';

export interface MentionCandidateRow {
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ReviewPersonKind;
}

export interface MentionSearchInput {
  readonly projectId: string;
  /** A display-name prefix (any word); empty for everyone. */
  readonly prefix: string;
  /** Exactly these users (the write-time check of a comment's mentions). */
  readonly userIds?: readonly string[] | undefined;
  readonly includeStaff: boolean;
  readonly includeClients: boolean;
  /** Only this client organization's contacts (the client door). */
  readonly clientOrganizationId?: string | null | undefined;
  readonly limit: number;
}

/** A thread author or resolver, by membership id (internal or client). */
export interface ReviewPersonRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ReviewPersonKind;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function nameFilter(prefix: string): SQL | undefined {
  if (prefix === '') return undefined;
  const escaped = escapeLike(prefix);
  return or(like(users.displayName, `${escaped}%`), like(users.displayName, `% ${escaped}%`));
}

export class ReviewMentionCandidatesRepository {
  async search(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: MentionSearchInput,
  ): Promise<readonly MentionCandidateRow[]> {
    const db = tenantDrizzle(runner);
    const names = nameFilter(input.prefix);
    const only =
      input.userIds === undefined
        ? undefined
        : input.userIds.length === 0
          ? null
          : inArray(users.id, [...input.userIds]);
    if (only === null) return [];
    const out: MentionCandidateRow[] = [];

    if (input.includeStaff) {
      const onProject = await db
        .select({ userId: users.id, displayName: users.displayName })
        .from(projectMemberships)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, projectMemberships.organizationId),
            eq(memberships.userId, projectMemberships.userId),
          ),
        )
        .innerJoin(users, eq(users.id, projectMemberships.userId))
        .where(
          and(
            eq(projectMemberships.organizationId, context.organizationId),
            eq(memberships.organizationId, context.organizationId),
            eq(projectMemberships.projectId, input.projectId),
            eq(memberships.status, 'active'),
            ne(memberships.role, PLATFORM_SUPPORT_ROLE),
            names,
            only,
          ),
        )
        .orderBy(asc(users.displayName))
        .limit(input.limit);
      const orgWide = await db
        .select({ userId: users.id, displayName: users.displayName })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.status, 'active'),
            eq(memberships.hasOrgWideScope, true),
            ne(memberships.role, PLATFORM_SUPPORT_ROLE),
            names,
            only,
          ),
        )
        .orderBy(asc(users.displayName))
        .limit(input.limit);
      for (const row of [...onProject, ...orgWide]) out.push({ ...row, kind: 'internal' });
    }

    if (input.includeClients) {
      const contacts = await db
        .select({ userId: users.id, displayName: users.displayName })
        .from(clientMemberships)
        .innerJoin(
          projectClients,
          and(
            eq(projectClients.organizationId, clientMemberships.organizationId),
            eq(projectClients.clientOrganizationId, clientMemberships.clientOrganizationId),
          ),
        )
        .innerJoin(users, eq(users.id, clientMemberships.userId))
        .where(
          and(
            eq(clientMemberships.organizationId, context.organizationId),
            eq(projectClients.organizationId, context.organizationId),
            eq(projectClients.projectId, input.projectId),
            eq(clientMemberships.status, 'active'),
            input.clientOrganizationId
              ? eq(clientMemberships.clientOrganizationId, input.clientOrganizationId)
              : undefined,
            names,
            only,
          ),
        )
        .orderBy(asc(users.displayName))
        .limit(input.limit);
      for (const row of contacts) out.push({ ...row, kind: 'client' });
    }
    return out;
  }

  /** Names for the membership ids a page of threads names (authors, resolvers). */
  async peopleByMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<readonly ReviewPersonRow[]> {
    if (membershipIds.length === 0) return [];
    const ids = [...new Set(membershipIds)];
    const db = tenantDrizzle(runner);
    const staff = await db
      .select({
        membershipId: memberships.id,
        userId: users.id,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, context.organizationId), inArray(memberships.id, ids)),
      );
    const clients = await db
      .select({
        membershipId: clientMemberships.id,
        userId: users.id,
        displayName: users.displayName,
      })
      .from(clientMemberships)
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.id, ids),
        ),
      );
    return [
      ...staff.map((row) => ({ ...row, kind: 'internal' as const })),
      ...clients.map((row) => ({ ...row, kind: 'client' as const })),
    ];
  }
}
