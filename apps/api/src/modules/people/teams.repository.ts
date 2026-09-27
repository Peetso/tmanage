import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, memberTeams, users } from '../../common/database/schema.js';
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
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.id));
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
