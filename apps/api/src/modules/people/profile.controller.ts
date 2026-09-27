import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PersonProfileRepository } from './profile.repository.js';

/**
 * x169's HTTP surface — one member's profile (module 14 People & capacity; audit #4 "People Missing
 * — profile view"). The per-member detail behind x168's directory: `GET
 * /v1/organizations/:orgSlug/people/:membershipId`, gated on `work.read` — the internal-read
 * capability the directory and the sibling insights reads already reuse, so the profile needs no new
 * capability and no `capabilities.ts` / role-grid edit. A pure read: no table, no column, no
 * migration.
 *
 * ## Resolve before authorize, on the membership id
 *
 * The route's `CapabilityGuard` already refuses a principal without `work.read` (a 403) before this
 * method runs. Inside it, the membership is **resolved tenant-scoped first** — `(organization_id,
 * :membershipId)` — and a cross-tenant or unknown id is a 404, indistinguishable from the id never
 * existing (the FAST-PROTOCOL Known-trap). Only then does the belt-and-braces `authorize()` run: the
 * org-level relation half of the route's `work.read` ceiling, so a client principal (the capability
 * is internal-only) is refused with a 403 here exactly as the guard refuses one, rather than a
 * profile being returned to an audience `work.read` never meant.
 *
 * ## Non-sensitive projection
 *
 * The view carries the member's display name, org role and membership status, the projects they
 * belong to, and a count of the open work they own — the same non-sensitive field set the directory
 * exposes. No email, locale or timezone is projected, and the open-work count reuses the owner's own
 * work-visibility scoping (My Day's open-state definition), never widening it.
 */

/**
 * One project the member belongs to, as it appears on the wire. Named without a `View` suffix — it
 * is the element type of {@link PersonProfileView.projects}, not a standalone endpoint projection, so
 * it is paired through its parent rather than as a contract of its own (the sibling forecast's
 * `WorkloadForecastWeek` uses the same convention).
 */
export interface PersonProfileProject {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  readonly role: string;
}

/**
 * x169's read shape — one member's profile. `membershipId`/`userId` identify the member; `displayName`,
 * `role` and `status` are the non-sensitive header; `projects` is the member's project memberships;
 * `openWorkCount` is how much open work they own. `computedAt` echoes when it was read. Computed,
 * never stored: no column, no write. Paired in `e2e/contracts/api-web-shapes.ts` with the web shape
 * the profile screen consumes (CONTRACT-001).
 */
export interface PersonProfileView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly projects: readonly PersonProfileProject[];
  readonly openWorkCount: number;
  readonly computedAt: string;
}

@Controller('v1/organizations/:orgSlug/people')
export class PersonProfileController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    private readonly profile: PersonProfileRepository,
  ) {}

  /**
   * One member's profile: role, project memberships and open-work count. Tenant-scoped by `orgSlug`;
   * the membership is resolved tenant-scoped **before** authorize (a cross-tenant/unknown id is a
   * 404), then a `work.read` refusal is a 403. A pure read — no write, no new column.
   */
  @Get(':membershipId')
  @RequireCapability('work.read')
  async personProfile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<PersonProfileView> {
    const now = new Date();

    const resolved = await this.database.read(context, async (runner) => {
      // Resolve first (Known-trap): a cross-tenant or unknown id is not found in this tenant.
      const member = await this.profile.findMember(runner, context, membershipId);
      if (member === null) return null;
      // Sequential, not `Promise.all`: one connection is bound to this unit of work and mysql2 does
      // not multiplex a connection across concurrent queries.
      const projects = await this.profile.listProjects(runner, context, member.userId);
      const openWorkCount = await this.profile.countOpenWork(runner, context, member.userId);
      return { member, projects, openWorkCount };
    });

    if (resolved === null) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'person_profile_not_found',
      );
    }

    // Belt-and-braces org-level relation check: the route's role ceiling mirrored. `work.read` is
    // internal-only, so a client is refused here — a 403, not a member's profile.
    if (!this.mayReadPeople(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'person_profile_denied');
    }

    const org = context.organizationId;
    return {
      membershipId: resolved.member.membershipId,
      userId: resolved.member.userId,
      displayName: resolved.member.displayName,
      role: resolved.member.role,
      status: resolved.member.status,
      // Belt-and-braces tenant filter before projecting (Known-trap: scope before the projection).
      projects: resolved.projects
        .filter(() => resolved.member.organizationId === org)
        .map((row) => ({
          projectId: row.projectId,
          name: row.name,
          status: row.status,
          role: row.role,
        })),
      openWorkCount: resolved.openWorkCount,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Whether this principal may read the org's people, judged by `work.read` against the organization
   * itself (`projectId: null`, internal audience) — the org-level relation half of the capability the
   * route gated on the role. An internal role that holds `work.read` is allowed; a client is refused
   * because `work.read` is internal-only, and a cross-tenant principal by the tenant check inside
   * `authorize`.
   */
  private mayReadPeople(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * x169's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into x168's people directory module, so the people slices stay file-disjoint.
 * The repository is a stateless collection of tenant-scoped reads, constructed here; the controller
 * injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class PersonProfileModule {
  static register(): DynamicModule {
    return {
      module: PersonProfileModule,
      providers: [
        { provide: PersonProfileRepository, useFactory: () => new PersonProfileRepository() },
      ],
      controllers: [PersonProfileController],
    };
  }
}
