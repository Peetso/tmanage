import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { PROJECT_SUMMARY_SERVICE } from './project-summary.service.js';
import type { ProjectSummaryService, ProjectSummaryView } from './project-summary.service.js';

/**
 * ONEPAGE (B01). `GET …/projects/:projectId/summary` — the project page's one read. `work.read` is
 * the coarse ceiling (the project page itself); the service authorises the project, then each
 * block. Two path segments after `projects`, so it cannot collide with `…/projects/:projectId`.
 * The organization comes from the verified `TenantContext`, never from the path or a body.
 */
@Controller('v1/organizations/:orgSlug/projects/:projectId/summary')
export class ProjectSummaryController {
  constructor(@Inject(PROJECT_SUMMARY_SERVICE) private readonly summaries: ProjectSummaryService) {}

  @Get()
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectSummaryView> {
    return this.summaries.get(context, principal, projectId);
  }
}
