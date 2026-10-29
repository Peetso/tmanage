import { and, asc, eq, gt, gte, inArray, isNull, like, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { PLATFORM_SUPPORT_ROLE, WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberAvailability,
  memberships,
  memberTeams,
  projectMemberships,
  sessions,
  users,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The People & capacity directory — module 14, audit #4.
 *
 * ## Why a second read over the same rows
 *
 * `MembershipsRepository.listWithNames` (D16) already names each active member for a picker.
 * This read answers a different question — *who is in this organization and how loaded are
 * they* — and adds the one field a picker never needed: how many projects the person is on.
 * That field is a `LEFT JOIN` over `project_memberships`, so it is a separate method rather
 * than another column on the picker's list, which several internal callers read as-is and
 * would then carry an aggregate they never use.
 *
 * ## Tenant scope is the same, and the join does not widen it
 *
 * `memberships` is anchored to the active organization by a bound `organization_id = ?`
 * exactly as the picker is. `users` carries no `organization_id` and is global identity, so it
 * needs no anchor. `project_memberships` is a tenant table, and its `LEFT JOIN` predicate ties
 * `project_memberships.organization_id` to `memberships.organization_id` — a join equality the
 * tenant guard follows to place it in the same anchored group. A person's project count is
 * therefore only ever counted from this tenant's own rows: an adjacent organization's
 * `project_memberships` row is unreachable because its `organization_id` never equals this
 * context's, so it falls outside the join and the count.
 *
 * ## The projection is deliberately narrow
 *
 * Name, email, role, status, a count and the membership's compare-and-swap `version` — no secret.
 * The email is read here because r-people prints it under the name, but the controller projects
 * it to internal principals only (B2): a client principal is refused by `work.read` already, and
 * the projection holds the line a second time. A member directory exists so the organization can
 * see who is on it and plan capacity by name, not so a roster becomes worth exfiltrating.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** One directory row: the member, the name they are known by, and how many projects they are on. */
export interface PersonDirectoryEntry {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly projectCount: number;
  /** `memberships.version`, the token `PATCH members/:userId/role` compares and swaps. */
  readonly version: number;
}

export interface PersonDirectoryOptions {
  readonly after?: string;
  readonly limit?: number;
  /**
   * A fragment of the name to look for, matched as a contains. Blank or whitespace-only is the
   * same as absent — an empty search box asks for everybody. It narrows this tenant's own query
   * and cannot widen who is reachable.
   */
  readonly q?: string;
}

/**
 * Make a person's typed text safe to put inside a `LIKE` pattern.
 *
 * `%` and `_` are `LIKE`'s wildcards and `\` its escape character. Not injection defence — the
 * pattern is a bound parameter and the guard would reject it otherwise — but so the pattern
 * means what was typed: a name containing `_` finds itself rather than every name of the same
 * length, and a typed `%` matches nothing rather than the whole roster.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Open work, as My Day and the profile count it: every state but `done` and `archived`. */
const OPEN_WORK_STATES: readonly WorkItemState[] = WORK_ITEM_STATES.filter(
  (state) => state !== 'done' && state !== 'archived',
);

/** PEO-01's extra columns for one member: teams, open commitments, declared availability. */
export interface PersonDirectoryDetails {
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly openCommitments: number;
  readonly overdueCommitments: number;
  readonly declared: {
    readonly kind: string;
    readonly startDate: string;
    readonly endDate: string;
  } | null;
  /** The member's latest sign-in or session refresh, or null for never (LAST ACTIVE). */
  readonly lastActiveAt: string | null;
}

/** A `max(datetime)` comes back as a Date or a string depending on the driver; ISO either way. */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export class PeopleDirectoryRepository {
  /**
   * The organization's active members, by name, each with a project count.
   *
   * Active only, and not a query parameter: an invited person authorises nothing and a
   * suspended one holds no capacity, so the capacity view answers the question it is actually
   * asked. Keyset-paged on `memberships.id`, the same cursor the picker uses.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: PersonDirectoryOptions = {},
  ): Promise<readonly PersonDirectoryEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const search = options.q?.trim() ?? '';

    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      inArray(memberships.status, ['active']),
      ne(memberships.role, PLATFORM_SUPPORT_ROLE), // PA-05 (SPEC §3.2): the hidden Support-mode role never shows here.
    ];
    if (options.after) predicates.push(gt(memberships.id, options.after));
    if (search !== '') {
      predicates.push(like(users.displayName, `%${escapeLikePattern(search)}%`));
    }

    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
        projectCount: sql<number>`count(distinct ${projectMemberships.id})`,
        email: users.email,
        version: memberships.version,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(
        projectMemberships,
        and(
          eq(projectMemberships.organizationId, memberships.organizationId),
          eq(projectMemberships.userId, memberships.userId),
        ),
      )
      .where(and(...predicates))
      .groupBy(
        memberships.id,
        memberships.userId,
        users.displayName,
        memberships.role,
        memberships.status,
        users.email,
        memberships.version,
      )
      .orderBy(asc(memberships.id))
      .limit(limit);

    return rows.map((row) => ({
      membershipId: row.membershipId,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      projectCount: Number(row.projectCount ?? 0),
      email: row.email,
      version: Number(row.version),
    }));
  }

  /**
   * PEO-01's per-row columns for one page of the directory, batched (four reads, never one per
   * row): the teams each member is assigned to, the open work each owns (and how much of it is past
   * due), the first availability window the member has **declared** that touches
   * `[fromDate, toDate]`, and when the member was last active (B2: the latest session sign-in or
   * refresh, the same signal the platform console reads). `sessions` is global identity, so that
   * read is anchored through this tenant's `memberships` row rather than by user id alone. Every statement binds every tenant table to `context.organizationId`; an
   * empty page reads nothing.
   */
  async rowDetails(
    runner: TenantQueryRunner,
    context: TenantContext,
    members: readonly { readonly membershipId: string; readonly userId: string }[],
    window: { readonly now: Date; readonly fromDate: string; readonly toDate: string },
  ): Promise<ReadonlyMap<string, PersonDirectoryDetails>> {
    const details = new Map<string, PersonDirectoryDetails>();
    if (members.length === 0) return details;
    const membershipIds = members.map((member) => member.membershipId);
    const userIds = [...new Set(members.map((member) => member.userId))];
    const org = context.organizationId;
    const db = tenantDrizzle(runner);

    // Sequential, not `Promise.all`: one connection is bound to this unit of work.
    const teamDefinitions = alias(memberTeams, 'team_definitions');
    const teamRows = await db
      .select({
        membershipId: memberTeams.membershipId,
        teamId: teamDefinitions.id,
        name: teamDefinitions.name,
      })
      .from(memberTeams)
      .innerJoin(
        teamDefinitions,
        and(eq(teamDefinitions.organizationId, org), eq(teamDefinitions.id, memberTeams.teamId)),
      )
      .where(
        and(eq(memberTeams.organizationId, org), inArray(memberTeams.membershipId, membershipIds)),
      )
      .orderBy(asc(teamDefinitions.name), asc(teamDefinitions.id));

    const workRows = await db
      .select({
        ownerUserId: workItems.ownerUserId,
        open: sql<number>`count(*)`,
        overdue: sql<number>`sum(case when ${workItems.dueAt} < ${window.now} then 1 else 0 end)`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, org),
          inArray(workItems.ownerUserId, userIds),
          inArray(workItems.state, [...OPEN_WORK_STATES]),
          isNull(workItems.deletedAt),
        ),
      )
      .groupBy(workItems.ownerUserId);

    const availabilityRows = await db
      .select({
        memberId: memberAvailability.memberId,
        startDate: memberAvailability.startDate,
        endDate: memberAvailability.endDate,
        kind: memberAvailability.kind,
      })
      .from(memberAvailability)
      .where(
        and(
          eq(memberAvailability.organizationId, org),
          inArray(memberAvailability.memberId, membershipIds),
          gte(memberAvailability.endDate, window.fromDate),
          lte(memberAvailability.startDate, window.toDate),
        ),
      )
      .orderBy(asc(memberAvailability.startDate), asc(memberAvailability.id));

    const activityRows = await db
      .select({
        membershipId: memberships.id,
        lastActiveAt: sql<unknown>`max(coalesce(${sessions.rotatedAt}, ${sessions.createdAt}))`,
      })
      .from(memberships)
      .innerJoin(sessions, eq(sessions.userId, memberships.userId))
      .where(and(eq(memberships.organizationId, org), inArray(memberships.id, membershipIds)))
      .groupBy(memberships.id);

    const work = new Map(workRows.map((row) => [row.ownerUserId, row]));
    const activity = new Map(activityRows.map((row) => [row.membershipId, row.lastActiveAt]));
    for (const member of members) {
      const owned = work.get(member.userId);
      const declared = availabilityRows.find((row) => row.memberId === member.membershipId);
      details.set(member.membershipId, {
        teams: teamRows
          .filter((row) => row.membershipId === member.membershipId)
          .map((row) => ({ id: row.teamId, name: row.name ?? '' })),
        openCommitments: Number(owned?.open ?? 0),
        overdueCommitments: Number(owned?.overdue ?? 0),
        declared: declared
          ? { kind: declared.kind, startDate: declared.startDate, endDate: declared.endDate }
          : null,
        lastActiveAt: toIsoOrNull(activity.get(member.membershipId)),
      });
    }
    return details;
  }
}
