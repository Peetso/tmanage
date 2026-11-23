import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PeopleTeamsRepository, TeamMember, TeamWithCount } from './teams.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * x262's orchestration — people teams (People module 14, planning PEO-03 "Team detail").
 *
 * The controller owns the capability decision (`org.manage` on the writes, `work.read` on the reads);
 * this service owns the tenant-scoped resolution and the writes themselves. Every mutating path
 * resolves the ids it names **inside the tenant before it writes** (the Known-trap): an unknown or
 * cross-tenant team id, and an assignment of a membership that is not a member of this studio, are
 * both a 404 with no write, never a foreign-key 500. The dup-name and idempotency invariants live
 * here too, so a controller cannot forget them.
 *
 * The tenant is always the `TenantContext` the guard built; no method reads `organizationId` from a
 * body.
 */

const MAX_NAME_LENGTH = 120;

/** A team plus its member count, as the service hands it up. */
export type { TeamWithCount, TeamMember };

/** One member of a team with how much open work they do (work area: the "Open work" column). */
export interface TeamMemberWithLoad extends TeamMember {
  readonly openWorkCount: number;
}

/** One team with its full member roster — the team-detail read. */
export interface TeamDetail {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly members: readonly TeamMemberWithLoad[];
}

/** The 409 a second team of the same name earns; one sentence for create and rename. */
function duplicateName(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'A team with this name already exists',
    [{ field: 'name', message: 'must be unique within the organization' }],
    'duplicate_team_name',
  );
}

export class PeopleTeamsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly teams: PeopleTeamsRepository,
    private readonly memberships: MembershipsRepository,
    /** Fix lane C. Optional so a unit test can build the service without one. */
    private readonly audit?: Pick<AuditService, 'record'>,
  ) {}

  /** Validate and normalise a team name, or throw a 400 with no write. */
  private normaliseName(name: unknown): string {
    if (typeof name !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: 'must be a string' },
      ]);
    }
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: `must be 1–${MAX_NAME_LENGTH} characters` },
      ]);
    }
    return trimmed;
  }

  /** List the tenant's teams with their member counts. */
  async listTeams(context: TenantContext): Promise<readonly TeamWithCount[]> {
    return this.database.read(context, (runner) => this.teams.listTeams(runner, context));
  }

  /**
   * One team with its members. Resolve the team tenant-scoped first (Known-trap): a cross-tenant or
   * unknown id is a 404 before the roster is read.
   */
  async getTeam(context: TenantContext, teamId: string): Promise<TeamDetail> {
    const detail = await this.database.read(context, async (runner) => {
      const team = await this.teams.findTeamById(runner, context, teamId);
      if (team === null) return null;
      const members = await this.teams.listMembers(runner, context, team.id);
      const open = await this.teams.openWorkCounts(
        runner,
        context,
        members.map((member) => member.membershipId),
      );
      return {
        team,
        members: members.map((member) => ({
          ...member,
          openWorkCount: open.get(member.membershipId) ?? 0,
        })),
      };
    });
    if (detail === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'team_not_found');
    }
    return {
      id: detail.team.id,
      name: detail.team.name,
      createdAt: detail.team.createdAt,
      members: detail.members,
    };
  }

  /**
   * Define a new team. A duplicate name in this tenant is a 409 with no second row — checked in code
   * and guarded by `uq_member_teams_org_name` at the engine.
   */
  async createTeam(context: TenantContext, rawName: unknown): Promise<TeamWithCount> {
    const name = this.normaliseName(rawName);
    const existing = await this.database.read(context, (runner) =>
      this.teams.findTeamByName(runner, context, name),
    );
    if (existing !== null) throw duplicateName();
    const definition = await this.database.transaction(context, async (tx) => {
      const created = await this.teams.createTeam(tx, context, name);
      // Work area: every team change leaves an audit row in its own unit of work (DA-11).
      await this.audit?.record(tx, context, {
        action: 'team.created',
        objectId: created.id,
        result: 'allowed',
        metadata: {},
      });
      return created;
    });
    return { definition, memberCount: 0 };
  }

  /**
   * Work area (2026-11-23): rename a team. Resolve it tenant-scoped first (404), refuse a name
   * another team of this tenant has (409, the unique index guards the race), audit the change.
   * Renaming to its own name is a no-op that still answers the team.
   */
  async renameTeam(
    context: TenantContext,
    teamId: string,
    rawName: unknown,
  ): Promise<TeamWithCount> {
    const name = this.normaliseName(rawName);
    return this.database.transaction(context, async (tx) => {
      const team = await this.teams.findTeamById(tx, context, teamId);
      if (team === null) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'team_not_found');
      }
      const count = (await this.teams.listTeams(tx, context)).find(
        (row) => row.definition.id === team.id,
      )?.memberCount;
      if (team.name !== name) {
        const clash = await this.teams.findTeamByName(tx, context, name);
        if (clash !== null && clash.id !== team.id) throw duplicateName();
        await this.teams.renameTeam(tx, context, team.id, name);
        await this.audit?.record(tx, context, {
          action: 'team.renamed',
          objectId: team.id,
          result: 'allowed',
          metadata: {},
        });
      }
      return { definition: { ...team, name }, memberCount: count ?? 0 };
    });
  }

  /**
   * Assign a member to a team. Resolve BOTH ids tenant-scoped before the write (Known-trap): an
   * unknown/cross-tenant team is a 404, and a membership that is not a member of this studio is a
   * 404 — never a foreign-key 500. Idempotent: a second identical assign is a no-op, guarded by
   * `uq_member_teams_assignment`.
   */
  async assignMember(context: TenantContext, teamId: string, membershipId: string): Promise<void> {
    const resolved = await this.database.read(context, async (runner) => {
      const team = await this.teams.findTeamById(runner, context, teamId);
      if (team === null) return { team: null, membership: null, assignment: null };
      const membership = await this.memberships.findById(runner, context, membershipId);
      if (membership === null) return { team, membership: null, assignment: null };
      const assignment = await this.teams.findAssignment(runner, context, team.id, membershipId);
      return { team, membership, assignment };
    });
    if (resolved.team === null || resolved.membership === null) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'team_or_member_not_found',
      );
    }
    // 60-09: teams are the people structure; an AI employee is never a team member.
    if (resolved.membership.kind !== 'human') {
      throw new ApiError(
        422,
        'validation_failed',
        'An AI employee is not counted as a person here.',
        [{ field: 'membershipId', message: 'An AI employee is not counted as a person here.' }],
        'team.ai_employee',
      );
    }
    // Idempotent: already assigned is success with no second row.
    if (resolved.assignment) return;
    await this.database.transaction(context, async (tx) => {
      await this.teams.createAssignment(tx, context, resolved.team.id, membershipId);
      await this.audit?.record(tx, context, {
        action: 'team.member_added',
        objectId: resolved.team.id,
        result: 'allowed',
        metadata: { membership_id: membershipId },
      });
    });
  }

  /**
   * Unassign a member from a team. Resolve the team tenant-scoped first (Known-trap → 404). Idempotent:
   * removing a member who is not on the team is success, not an error.
   */
  async removeMember(context: TenantContext, teamId: string, membershipId: string): Promise<void> {
    const team = await this.database.read(context, (runner) =>
      this.teams.findTeamById(runner, context, teamId),
    );
    if (team === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'team_not_found');
    }
    await this.database.transaction(context, async (tx) => {
      const removed = await this.teams.deleteAssignment(tx, context, team.id, membershipId);
      if (!removed) return;
      await this.audit?.record(tx, context, {
        action: 'team.member_removed',
        objectId: team.id,
        result: 'allowed',
        metadata: { membership_id: membershipId },
      });
    });
  }

  /**
   * Fix lane C (2026-11-23). Delete a team. The people stay in the workspace; only the grouping
   * goes. Resolve the team tenant-scoped first (unknown or another tenant's is 404); the delete and
   * its audit row are one unit of work.
   */
  async deleteTeam(context: TenantContext, teamId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const team = await this.teams.findTeamById(tx, context, teamId);
      if (team === null) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'team_not_found');
      }
      const memberCount = await this.teams.deleteTeam(tx, context, team.id);
      await this.audit?.record(tx, context, {
        action: 'team.deleted',
        objectId: team.id,
        result: 'allowed',
        metadata: { member_count: memberCount },
      });
    });
  }
}
