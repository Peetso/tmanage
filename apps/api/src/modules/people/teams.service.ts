import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PeopleTeamsRepository, TeamMember, TeamWithCount } from './teams.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';

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

/** One team with its full member roster — the team-detail read. */
export interface TeamDetail {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly members: readonly TeamMember[];
}

export class PeopleTeamsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly teams: PeopleTeamsRepository,
    private readonly memberships: MembershipsRepository,
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
      return { team, members };
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
    if (existing !== null) {
      throw new ApiError(
        409,
        'conflict',
        'A team with this name already exists',
        [{ field: 'name', message: 'must be unique within the organization' }],
        'duplicate_team_name',
      );
    }
    const definition = await this.database.transaction(context, (tx) =>
      this.teams.createTeam(tx, context, name),
    );
    return { definition, memberCount: 0 };
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
    // Idempotent: already assigned is success with no second row.
    if (resolved.assignment) return;
    await this.database.transaction(context, (tx) =>
      this.teams.createAssignment(tx, context, resolved.team.id, membershipId),
    );
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
    await this.database.transaction(context, (tx) =>
      this.teams.deleteAssignment(tx, context, team.id, membershipId),
    );
  }
}
