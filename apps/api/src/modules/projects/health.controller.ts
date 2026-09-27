import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_HEALTH_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectHealthService, ProjectHealthView } from './health.service.js';

/**
 * PROJ / module 8 (x208). The read-only computed project-health roll-up, gated on `work.read` — the
 * same ceiling the portfolio (x137) uses, because health reads the very same visible-project set.
 *
 * Two controllers, one per shape:
 *
 * - {@link ProjectHealthListController} at the static segment `…/projects/health` — the band per
 *   project across the tenant. Mounted as its own static path exactly as `…/projects/portfolio` is,
 *   so the router matches it before the sibling `…/projects/:projectId`; `health` is never read as a
 *   project id.
 * - {@link ProjectHealthController} at `…/projects/:projectId/health` — one project's health. Its two
 *   path segments cannot collide with the one-segment `…/projects/:projectId` read.
 *
 * Neither reads `organizationId` from the body, a header, or its `:orgSlug` segment: each receives the
 * `TenantContext` the `TenantContextGuard` built and passes it on. The tenant filter, the relation
 * gate, the fixed band thresholds and the 404-for-invisible mapping are the service's.
 */
@Controller('v1/organizations/:orgSlug/projects/health')
export class ProjectHealthListController {
  constructor(@Inject(PROJECT_HEALTH_SERVICE) private readonly health: ProjectHealthService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly projects: readonly ProjectHealthView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      projects: await this.health.list(context, principal, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/health')
export class ProjectHealthController {
  constructor(@Inject(PROJECT_HEALTH_SERVICE) private readonly health: ProjectHealthService) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectHealthView> {
    return this.health.get(context, principal, projectId);
  }
}
