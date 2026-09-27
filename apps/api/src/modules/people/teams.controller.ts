import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PeopleTeamsRepository } from './teams.repository.js';
import { PeopleTeamsService } from './teams.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';

/**
 * PEOPLE / module 14 (x262). Named people teams and their members — planning PEO-03 "Team detail",
 * 38-MODULE-MAP §People ("Directory, teams, profile"). x168 built the directory and x216-x218 the
 * profile/org-chart/availability; teams is the untouched surface. Mounted under
 * `…/people/teams` (a static segment, so it never collides with the sibling `…/people/:membershipId`
 * profile route).
 *
 * ## The route ceilings, and resolve-before-authorize
 *
 * Team administration — creating a team and assigning/unassigning members — is gated on `org.manage`
 * (the team-admin capability). Reading — the team list and a team's detail — is gated on `work.read`,
 * the internal-read capability the directory and profile already reuse. `CapabilityGuard` refuses a
 * role without the capability (a 403) before the handler runs; the handler *also* runs the real
 * `authorize()` for the same capability, org-wide, so a client (both capabilities are internal-only)
 * and a cross-tenant principal are refused here exactly as the guard refuses one — the belt-and-braces
 * pattern the sibling `PersonAllocationsController` and `OrgPoliciesController` use.
 *
 * The team is resolved tenant-scoped **before** authorize on the reads and before any write (in the
 * service), so a cross-tenant or unknown id is a 404 indistinguishable from the id never existing.
 * No capability edit: it reuses existing caps, so no `capabilities.ts` / role-grid change.
 */

/** A team as a list row: its id, name, member count, and when it was created. */
export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** One member of a team — the non-sensitive header the directory also exposes. */
export interface TeamMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
}

/** One team with its full member roster — the team-detail read. */
export interface TeamDetailView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly members: readonly TeamMemberView[];
}

interface CreateTeamBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug/people/teams')
export class PeopleTeamsController {
  constructor(private readonly service: PeopleTeamsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly teams: readonly TeamView[] }> {
    this.requireOrgRead(principal, context);
    const rows = await this.service.listTeams(context);
    return {
      teams: rows.map((row) => ({
        id: row.definition.id,
        name: row.definition.name,
        memberCount: row.memberCount,
        createdAt: row.definition.createdAt.toISOString(),
      })),
    };
  }

  @Get(':id')
  @RequireCapability('work.read')
  async detail(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') teamId: string,
  ): Promise<TeamDetailView> {
    // Resolve the team tenant-scoped BEFORE the belt-and-braces authorize (Known-trap): a
    // cross-tenant/unknown id is a 404, and a client's probe earns the same not-found, not a 403.
    const detail = await this.service.getTeam(context, teamId);
    this.requireOrgRead(principal, context);
    return {
      id: detail.id,
      name: detail.name,
      createdAt: detail.createdAt.toISOString(),
      members: detail.members.map((member) => ({
        membershipId: member.membershipId,
        userId: member.userId,
        displayName: member.displayName,
        role: member.role,
        status: member.status,
      })),
    };
  }

  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTeamBody,
  ): Promise<TeamView> {
    // The team-admin decision, org-wide: refuse before any write (a client/cross-tenant is a 403
    // here, exactly as the guard refuses a role without org.manage).
    this.requireOrgManage(principal, context);
    const row = await this.service.createTeam(context, body?.name);
    return {
      id: row.definition.id,
      name: row.definition.name,
      memberCount: row.memberCount,
      createdAt: row.definition.createdAt.toISOString(),
    };
  }

  @Put(':id/members/:membershipId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') teamId: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    this.requireOrgManage(principal, context);
    await this.service.assignMember(context, teamId, membershipId);
  }

  @Delete(':id/members/:membershipId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async unassign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') teamId: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    this.requireOrgManage(principal, context);
    await this.service.removeMember(context, teamId, membershipId);
  }

  /**
   * The org-wide `org.manage` decision (`projectId: null`, internal audience). An internal role
   * holding it passes; a client is refused (`org.manage` is internal-only), and a cross-tenant
   * principal by the tenant check inside `authorize`. A denial is a 403 with a machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `people_teams.write:${verdict.code}`,
      );
    }
  }

  /**
   * The org-wide `work.read` decision — the internal-read half of the read routes' ceiling. A client
   * is refused because `work.read` is internal-only; a cross-tenant principal by the tenant check.
   */
  private requireOrgRead(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `people_teams.read:${verdict.code}`,
      );
    }
  }
}

/**
 * x262's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * kept separate from the other People modules so the People slices stay file-disjoint. The service
 * resolves the `@Global` `TENANT_DATABASE` and its two stateless repositories (the teams repository
 * and the shared memberships repository, constructed here); the controller injects the service.
 */
@Module({})
export class PeopleTeamsModule {
  static register(): DynamicModule {
    return {
      module: PeopleTeamsModule,
      providers: [
        { provide: PeopleTeamsRepository, useFactory: () => new PeopleTeamsRepository() },
        { provide: MembershipsRepository, useFactory: () => new MembershipsRepository() },
        {
          provide: PeopleTeamsService,
          useFactory: (
            database: TenantDatabase,
            teams: PeopleTeamsRepository,
            memberships: MembershipsRepository,
          ) => new PeopleTeamsService(database, teams, memberships),
          inject: [TENANT_DATABASE, PeopleTeamsRepository, MembershipsRepository],
        },
      ],
      controllers: [PeopleTeamsController],
    };
  }
}
