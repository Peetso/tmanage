import { Controller, Get, Inject, Param } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { toPortalTimeline } from '../clients/project-milestones.projection.js';
import type { PortalTimelineResponse } from '../clients/project-milestones.projection.js';
import { ProjectPhasesRepository } from '../projects/phases.repository.js';

/**
 * 53-07 — the client's project timeline (`client_projection.read`).
 *
 * It reads ONLY the published copies in `milestone_client_projections` and the phase definition
 * rows (name and band dates). It never touches a live `project_milestones` row, so an owner, the
 * internal title, the forecast or a date-change reason has no path to the response (53-T-17). The
 * project must be one the client organization reaches through `project_clients` — `authorize()`
 * reads that from `principal.projectIds` — otherwise the answer is 404, never 403 or an empty
 * timeline, so a client probing ids learns nothing.
 */
export class PortalTimelineService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
    private readonly phases: ProjectPhasesRepository = new ProjectPhasesRepository(),
  ) {}

  async timeline(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalTimelineResponse> {
    const permitted = authorize({
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
    if (!permitted) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const { definitions, copies } = await this.database.read(context, async (runner) => ({
      definitions: await this.phases.listDefinitions(runner, context, projectId),
      copies: await this.milestones.listProjections(runner, context, projectId),
    }));
    return toPortalTimeline(
      definitions.map((row) => ({
        id: row.id,
        name: row.name,
        position: row.position,
        startsOn: row.startsOn ?? null,
        endsOn: row.endsOn ?? null,
      })),
      copies,
    );
  }
}

@Controller('v1/organizations/:orgSlug/portal')
export class PortalTimelineController {
  constructor(@Inject(PortalTimelineService) private readonly portal: PortalTimelineService) {}

  /** The client timeline: phase bands and published milestones (title, committed date, status). */
  @Get('projects/:projectId/timeline')
  @RequireCapability('client_projection.read')
  async timeline(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<PortalTimelineResponse> {
    return this.portal.timeline(context, principal, projectId);
  }
}
