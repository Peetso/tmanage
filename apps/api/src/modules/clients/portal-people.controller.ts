import { Controller, Get, Inject, Param } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { PortalPeopleProjection } from './portal-people.projection.js';
import type { PortalPersonView } from './portal-people.projection.js';

/**
 * The client portal's **people** read surface — module 13 portal, x142 (SEC).
 *
 * A path on `/portal`, alongside `PortalController`, and a security property rather than a routing
 * preference (the reason `PortalController`'s own doc gives): an internal endpoint that served a
 * client projection when asked nicely is one refactor away from serving the internal record. This
 * route reaches a projection that never selects an internal column — see
 * {@link PortalPeopleProjection}.
 *
 * A controller of its own, wired by {@link PortalPeopleModule}, rather than a method added to
 * `PortalService`/`PortalController`: it shares no state with the update/work reads and keeping it
 * self-contained keeps this slice's files disjoint from the sibling portal slices.
 *
 * `client_projection.read` — the capability `12-PERMISSION-MATRIX` §1 names for the client
 * projection, the same gate every other `/portal` read carries. `CapabilityGuard` refuses a role
 * without it before this handler runs.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalPeopleController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    // Constructed defaults, so a unit test can drive the handler with fakes and the real
    // `authorize()`. `PortalPeopleModule` provides both by class token for the injected instance.
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly people: PortalPeopleProjection = new PortalPeopleProjection(),
  ) {}

  /**
   * `CL` People — the client-visible team of one of this client's projects.
   *
   * The Known trap (FAST-PROTOCOL 19:55): the route names the project by id, so the project is
   * **resolved tenant-scoped first** and only then relation-checked, both before any people are
   * read:
   *
   * 1. {@link ProjectsRepository.findById} is tenant-scoped. An unknown or **cross-tenant**
   *    `projectId` returns `null` → **404**. This runs before the relation check so a project in
   *    another tenant is a not-found, never a foreign-key surprise later.
   * 2. `authorize()` at audience `client_visible`: for a client principal that runs rules 7–10 —
   *    same client organization, client-readable audience, and the project in
   *    `principal.projectIds` (which comes from `project_clients` and nothing else). A project in
   *    this tenant but **not shared with this client** fails it → **404, not 403**: a client
   *    probing project ids must not learn which of them are real (the reasoning `PortalService`
   *    gives for its own reads).
   *
   * Only once the project is proven to be this client's are its members read, and the projection
   * returns `{ displayName, role }` per person — never an email, membership id or user id (a
   * member not on this project is never in the result because the query is project-scoped).
   */
  @Get('projects/:projectId/people')
  @RequireCapability('client_projection.read')
  async people_(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly people: readonly PortalPersonView[] }> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      // 404, not 403 — a cross-tenant or unknown id must not be distinguishable from a real one.
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    if (!this.mayRead(principal, projectId)) {
      // 404, not 403 — the project exists, but confirming that to a client who cannot read it is
      // the disclosure this refusal exists to prevent.
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const people = await this.database.read(context, (runner) =>
      this.people.listForProject(runner, context, projectId),
    );
    return { people };
  }

  /**
   * May this principal read the client projection of this project?
   *
   * One `authorize()` at audience `client_visible`, exactly as `PortalService.mayRead` does — the
   * audience the projection actually has. For a client principal that is rules 7–10; for an
   * internal principal it answers "what can the client see", which is how anyone at the agency
   * checks the people list without asking the client.
   */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}
