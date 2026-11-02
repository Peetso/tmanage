import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  BurndownView,
  CompleteView,
  IterationDetailView,
  IterationListView,
  IterationView,
  IterationsService,
  MoveItemsView,
} from './iterations.service.js';

export const ITERATIONS_SERVICE = Symbol.for('tmanage.IterationsService');

/**
 * 53-21 — iterations (light sprints) and points.
 *
 * Route gates are coarse; the service decides per project and per item. Capabilities: there is no
 * `schedule.manage` key, so create / edit / complete / the points switch are `project.manage` on the
 * project, moving items is `work.update` on every item, reads are `work.read`. Clients never reach
 * an iteration (404), and no portal or public-link route serves one. 55-04 Simple/Power mode has no
 * backend gate: the Iterations tab is the web's. No feature flag: iterations are on for every org.
 */
@Controller('v1/organizations/:orgSlug')
export class IterationsController {
  constructor(@Inject(ITERATIONS_SERVICE) private readonly iterations: IterationsService) {}

  @Get('projects/:projectId/iterations')
  @RequireCapability('work.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<IterationListView> {
    return this.iterations.list(context, principal, projectId);
  }

  @Post('projects/:projectId/iterations')
  @RequireCapability('project.manage')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<IterationView> {
    return this.iterations.create(context, principal, projectId, body);
  }

  /** The project's story-points switch (`points_enabled`), one field. */
  @Put('projects/:projectId/iteration-settings')
  @RequireCapability('project.manage')
  setPoints(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<{ readonly projectId: string; readonly pointsEnabled: boolean }> {
    return this.iterations.setPointsEnabled(context, principal, projectId, body);
  }

  @Get('iterations/:iterationId')
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('iterationId') iterationId: string,
  ): Promise<IterationDetailView> {
    return this.iterations.get(context, principal, iterationId);
  }

  @Put('iterations/:iterationId')
  @RequireCapability('project.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('iterationId') iterationId: string,
    @Body() body: unknown,
  ): Promise<IterationView> {
    return this.iterations.update(context, principal, iterationId, body);
  }

  @Get('iterations/:iterationId/burndown')
  @RequireCapability('work.read')
  burndown(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('iterationId') iterationId: string,
  ): Promise<BurndownView> {
    return this.iterations.burndown(context, principal, iterationId);
  }

  @Post('iterations/:iterationId/items')
  @RequireCapability('work.update')
  @HttpCode(200)
  moveItems(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('iterationId') iterationId: string,
    @Body() body: unknown,
  ): Promise<MoveItemsView> {
    return this.iterations.moveItems(context, principal, iterationId, body);
  }

  @Post('iterations/:iterationId/complete')
  @RequireCapability('project.manage')
  @HttpCode(200)
  complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('iterationId') iterationId: string,
    @Body() body: unknown,
  ): Promise<CompleteView> {
    return this.iterations.complete(context, principal, iterationId, body);
  }
}
