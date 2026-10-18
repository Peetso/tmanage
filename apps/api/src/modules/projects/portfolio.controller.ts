import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_PORTFOLIO_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectPortfolioService, ProjectPortfolioView } from './portfolio.service.js';
import { ProjectPortfolioCapacityService } from './portfolio-capacity.service.js';
import type { PortfolioCapacityView } from './portfolio-capacity.service.js';

/**
 * PROJ / module 8 (x137). The read-only portfolio roll-up: one summary row per project the caller can
 * see, across the whole tenant, gated on `work.read`.
 *
 * Mounted at `…/projects/portfolio` — a static segment, so the router matches it before the sibling
 * `…/projects/:projectId` in `ProjectsController`; `portfolio` is never read as a project id. Like
 * every tenant-scoped controller here it never reads `organizationId` from the body, a header, or its
 * own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built from a
 * membership row and passes it on. The tenant-and-relation filter, the deterministic order and the
 * bounded page are the service's.
 */
@Controller('v1/organizations/:orgSlug/projects/portfolio')
export class ProjectPortfolioController {
  constructor(
    @Inject(PROJECT_PORTFOLIO_SERVICE) private readonly portfolio: ProjectPortfolioService,
    @Inject(ProjectPortfolioCapacityService)
    private readonly capacityService: ProjectPortfolioCapacityService,
  ) {}

  /**
   * POR-03. Load by discipline for one week (`?week=YYYY-MM-DD`, normalised to its Monday; this week
   * by default) and the unstaffed commitments in the caller's visible projects.
   */
  @Get('capacity')
  @RequireCapability('work.read')
  async capacity(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('week') week?: string,
  ): Promise<PortfolioCapacityView> {
    return this.capacityService.view(context, principal, week === undefined ? {} : { week });
  }

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly projects: readonly ProjectPortfolioView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      projects: await this.portfolio.list(context, principal, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }
}
