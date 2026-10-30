import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  ActiveTimerView,
  TimeEntryView,
  TimeService,
  TimerStateView,
} from './time.service.js';

export const TIME_SERVICE = Symbol.for('tmanage.TimeService');

/**
 * 52-01 — `/v1/organizations/:orgSlug/time`: the caller's own running timer and, when the
 * organization allows it, presence. The route gate is `work.read` (the "track own" stand-in in
 * `time-capabilities.ts`); the service asks it again against the item or project the time is for
 * and refuses client principals. No body or query names a person or an organization. No public
 * route.
 */
@Controller('v1/organizations/:orgSlug/time')
export class TimeController {
  constructor(@Inject(TIME_SERVICE) private readonly service: TimeService) {}

  @Get('timer')
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TimerStateView> {
    return this.service.get(context, principal);
  }

  @Post('timer/start')
  @RequireCapability('work.read')
  @HttpCode(201)
  start(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TimerStateView> {
    return this.service.start(context, principal, body);
  }

  @Post('timer/stop')
  @RequireCapability('work.read')
  @HttpCode(200)
  stop(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TimeEntryView> {
    return this.service.stop(context, principal, body);
  }

  @Post('timer/heartbeat')
  @RequireCapability('work.read')
  @HttpCode(200)
  heartbeat(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TimerStateView> {
    return this.service.heartbeat(context, principal);
  }

  @Get('active')
  @RequireCapability('work.read')
  active(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
  ): Promise<{ readonly timers: readonly ActiveTimerView[] }> {
    return this.service.active(context, principal, projectId);
  }
}
