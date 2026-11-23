import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { PLATFORM_SUPPORT_ROLE, uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  memberTeams,
  users,
  workItemAssignees,
  workItems,
} from '../../common/database/schema.js';
import type { MemberTeamRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x262's write/read seam — people teams (People module 14, planning PEO-03 "Team detail").
 *
 * One table (`member_teams`) holds two row kinds, the x233 `work_item_labels` pattern:
 *
 *   * a **definition** row is a team — `name` set, `team_id`/`membership_id` NULL;
 *   * an **assignment** row places a member on a team — `team_id` + `membership_id` set, `name` NULL.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext`, the tenant comes from the
 * context and never from a DTO, and the `organization_id` predicate is on every statement. The
 * repository carries no policy — the route gate and the belt-and-braces `authorize()` live in the
 * controller — and no connection: the runner is a parameter.
 */

/** A team definition — the `name` row. Its `id` is the `team_id` assignments point at. */
export interface TeamDefinition {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** A team's member, resolved through the assignment row to the membership and the user's name. */
export interface TeamMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
}

/** One person in one team, for the Teams list's faces and people count. */
export interface TeamRosterEntry {
  readonly teamId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

/** One team plus how many members it has — the list row. */
export interface TeamWithCount {
  readonly definition: TeamDefinition;
  readonly memberCount: number;
}

function toDefinition(row: MemberTeamRow): TeamDefinition {
  return { id: row.id, name: row.name ?? '', createdAt: row.createdAt };
}

export class PeopleTeamsRepository {
  /**
   * The definition rows in this tenant, each with its member count, ordered by name for a stable
   * read. A single grouped left join over the assignment rows, so the count never turns into a
   * per-team round trip. Bounded — a studio's team count is small — so unpaged.
   */
  async listTeams(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly TeamWithCount[]> {
    const assignments = alias(memberTeams, 'assignments');
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        id: memberTeams.id,
        name: memberTeams.name,
        createdAt: memberTeams.createdAt,
        memberCount: sql<number>`count(${assignments.id})`,
      })
      .from(memberTeams)
      .leftJoin(
        assignments,
        and(
          eq(assignments.organizationId, context.organizationId),
          eq(assignments.teamId, memberTeams.id),
        ),
      )
      .where(
        and(eq(memberTeams.organizationId, context.organizationId), isNotNull(memberTeams.name)),
      )
      .groupBy(memberTeams.id, memberTeams.name, memberTeams.createdAt)
      .orderBy(asc(memberTeams.name), asc(memberTeams.id));
    return rows.map((row) => ({
      definition: { id: row.id, name: row.name ?? '', createdAt: row.createdAt },
      memberCount: Number(row.memberCount ?? 0),
    }));
  }

  /**
   * Resolve one team definition by id within this tenant (the Known-trap): a cross-tenant or unknown
   * id, or an id that names an assignment row rather than a definition, is not found. `name` NOT NULL
   * pins it to a definition row.
   */
  async findTeamById(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
  ): Promise<TeamDefinition | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.id, teamId),
          isNotNull(memberTeams.name),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toDefinition(row) : null;
  }

  /** Whether a team of this name already exists in this tenant — the duplicate-name (409) check. */
  async findTeamByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<TeamDefinition | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberTeams)
      .where(
        and(eq(memberTeams.organizationId, context.organizationId), eq(memberTeams.name, name)),
      )
      .limit(1);
    const row = rows[0];
    return row ? toDefinition(row) : null;
  }

  /** Insert a team definition row (name set; team_id/membership_id NULL). */
  async createTeam(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<TeamDefinition> {
    const row = {
      id: uuidv7(),
      organizationId: context.organizationId,
      teamId: null,
      membershipId: null,
      name,
      createdAt: new Date(),
    };
    await tenantDrizzle(runner).insert(memberTeams).values(row);
    return { id: row.id, name, createdAt: row.createdAt };
  }

  /** One team's members, resolved through assignment rows to memberships and the user display name. */
  async listMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
  ): Promise<readonly TeamMember[]> {
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberTeams)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, memberTeams.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.teamId, teamId),
          isNotNull(memberTeams.membershipId),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE), // PA-05 (SPEC §3.2): the hidden Support-mode role never shows here.
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.id));
  }

  /**
   * Work area (Teams page): every team's people in one read, for the list's faces and the header's
   * distinct-people count. One query over all assignments in the tenant instead of a roster read
   * per team; bounded by members × teams, which is small for a studio. The same joins and the same
   * hidden Support-mode filter as {@link listMembers}, so a face is never someone the roster hides.
   */
  async listRosters(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly TeamRosterEntry[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        teamId: memberTeams.teamId,
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
      })
      .from(memberTeams)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, memberTeams.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          isNotNull(memberTeams.teamId),
          isNotNull(memberTeams.membershipId),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE),
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.id));
    return rows.map((row) => ({ ...row, teamId: row.teamId ?? '' }));
  }

  /** Whether this (team, membership) assignment already exists — the idempotency check. */
  async findAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    membershipId: string,
  ): Promise<MemberTeamRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.teamId, teamId),
          eq(memberTeams.membershipId, membershipId),
          isNull(memberTeams.name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Work area (2026-11-23): rename a team definition. Returns whether a row was changed. */
  async renameTeam(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    name: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(memberTeams)
      .set({ name })
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.id, teamId),
          isNotNull(memberTeams.name),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Work area: how many open work items (not done, not archived, not deleted) each member does,
   * for the team page's "Open work" column. The doer rows are the single source since 0412, so a
   * lead is counted through its own row. Members with none are absent from the map.
   */
  async openWorkCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (membershipIds.length === 0) return new Map();
    const a = workItemAssignees;
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: a.membershipId,
        open: sql<number>`count(distinct ${workItems.id})`,
      })
      .from(a)
      .innerJoin(
        workItems,
        and(eq(workItems.organizationId, a.organizationId), eq(workItems.id, a.workItemId)),
      )
      .where(
        and(
          eq(a.organizationId, context.organizationId),
          eq(a.role, 'doer'),
          inArray(a.membershipId, [...membershipIds]),
          isNull(workItems.deletedAt),
          notInArray(workItems.state, ['done', 'archived']),
        ),
      )
      .groupBy(a.membershipId);
    return new Map(rows.map((row) => [row.membershipId, Number(row.open)]));
  }

  /** Insert an assignment row (team_id + membership_id set; name NULL). */
  async createAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    membershipId: string,
  ): Promise<void> {
    await tenantDrizzle(runner).insert(memberTeams).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      teamId,
      membershipId,
      name: null,
      createdAt: new Date(),
    });
  }

  /**
   * Fix lane C (2026-11-23). Delete a team: its assignment rows first (they point at the definition
   * through `fk_member_teams_team`), then the definition. Returns how many members it had.
   */
  async deleteTeam(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const members = await db
      .delete(memberTeams)
      .where(
        and(eq(memberTeams.organizationId, context.organizationId), eq(memberTeams.teamId, teamId)),
      );
    await db
      .delete(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.id, teamId),
          isNotNull(memberTeams.name),
        ),
      );
    return members[0].affectedRows;
  }

  /** Remove an assignment row. Returns true when a row was deleted (false when it was not assigned). */
  async deleteAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    membershipId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.teamId, teamId),
          eq(memberTeams.membershipId, membershipId),
          isNull(memberTeams.name),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
