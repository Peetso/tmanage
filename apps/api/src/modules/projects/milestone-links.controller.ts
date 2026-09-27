import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MILESTONE_LINKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MilestoneLinksService, MilestoneLinkView } from './milestone-links.service.js';

/**
 * PROJ / module 8 (x236). The dependency edges from one project milestone to the milestones it
 * depends on: link, list, unlink.
 *
 * Nested under `…/projects/milestones/:milestoneId/links`, so the milestone is named in the path and
 * the service resolves it (and its project, for the relation gate) tenant-scoped before it authorizes
 * or writes (Known-trap). Every route is gated on `project.manage`. Like every tenant-scoped
 * controller here, it never reads `organizationId` from the body, a header, or its own `:orgSlug`
 * segment: it receives the `TenantContext` `TenantContextGuard` built and passes it on.
 */

interface CreateMilestoneLinkBody {
  readonly dependsOnMilestoneId?: unknown;
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

@Controller('v1/organizations/:orgSlug/projects/milestones/:milestoneId/links')
export class MilestoneLinksController {
  constructor(@Inject(MILESTONE_LINKS_SERVICE) private readonly links: MilestoneLinksService) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('milestoneId') milestoneId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly dependencies: readonly MilestoneLinkView[] }> {
    requireId(milestoneId, 'milestoneId');

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      dependencies: await this.links.list(context, principal, {
        milestoneId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async link(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('milestoneId') milestoneId: string,
    @Body() body: CreateMilestoneLinkBody,
  ): Promise<MilestoneLinkView> {
    requireId(milestoneId, 'milestoneId');
    const dependsOnMilestoneId =
      typeof body?.dependsOnMilestoneId === 'string' ? body.dependsOnMilestoneId.trim() : '';
    if (dependsOnMilestoneId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'dependsOnMilestoneId', message: 'must be a non-empty string' },
      ]);
    }

    return this.links.link(context, principal, { milestoneId, dependsOnMilestoneId });
  }

  @Delete(':dependsOnMilestoneId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async unlink(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('milestoneId') milestoneId: string,
    @Param('dependsOnMilestoneId') dependsOnMilestoneId: string,
  ): Promise<void> {
    requireId(milestoneId, 'milestoneId');
    requireId(dependsOnMilestoneId, 'dependsOnMilestoneId');
    await this.links.unlink(context, principal, milestoneId, dependsOnMilestoneId);
  }
}
