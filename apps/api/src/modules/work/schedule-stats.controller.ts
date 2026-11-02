import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { CriticalPathResponse, ScheduleStatsService } from './schedule-stats.service.js';

/**
 * 53-06's HTTP surface. The read is `work.read` plus the project relation (the service maps an
 * invisible project to 404); the recompute is `project.manage`, immediate and audited. Neither reads
 * an organization from the request: both take the `TenantContext` the guard built.
 *
 * The read is throttled at 30 a minute — keyed by address, because the durable limiter has no
 * per-user key — since a stale read recomputes synchronously.
 */

export const WORK_SCHEDULE_STATS_SERVICE = Symbol.for('tmanage.WorkScheduleStatsService');

@Controller('v1/organizations/:orgSlug/projects/:projectId/schedule')
export class ScheduleStatsController {
  constructor(
    @Inject(WORK_SCHEDULE_STATS_SERVICE) private readonly schedule: ScheduleStatsService,
  ) {}

  @Get('critical-path')
  @RequireCapability('work.read')
  @Throttle('schedule_critical_path', { perMinute: 30, key: 'ip', onStoreError: 'open' })
  async criticalPath(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<CriticalPathResponse> {
    return this.schedule.criticalPathOf(context, principal, projectId);
  }

  @Post('recompute')
  @RequireCapability('project.manage')
  @HttpCode(200)
  async recompute(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<CriticalPathResponse> {
    return this.schedule.recomputeNow(context, principal, projectId);
  }
}
