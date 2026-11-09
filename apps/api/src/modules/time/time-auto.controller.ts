import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AutoTrackingPolicy, Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TIME_TRACK_OWN, TIME_VIEW_TEAM } from './time-capabilities.js';
import type { AutoTrackingView, TimeAutoService } from './time-auto.service.js';
import type { TeamDayView, TeamTimeView, TimeTeamService } from './time-team.service.js';

export const TIME_AUTO_SERVICE = Symbol.for('tmanage.TimeAutoService');
export const TIME_TEAM_SERVICE = Symbol.for('tmanage.TimeTeamService');

/**
 * FIX-2026-11-10 — `/v1/organizations/:orgSlug/time/auto`: the caller's own automatic tracking.
 * The route gate is `work.read` (the "track own" stand-in); the service refuses client principals
 * and never reads a person or a time from the body. The heartbeat is rate-limited per member.
 * `PATCH policy` is the company owner's (checked in the service, audited).
 */
@Controller('v1/organizations/:orgSlug/time/auto')
export class TimeAutoController {
  constructor(@Inject(TIME_AUTO_SERVICE) private readonly service: TimeAutoService) {}

  @Get()
  @RequireCapability(TIME_TRACK_OWN)
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutoTrackingView> {
    return this.service.get(context, principal);
  }

  @Put('settings')
  @RequireCapability(TIME_TRACK_OWN)
  settings(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AutoTrackingView> {
    return this.service.updateSettings(context, principal, body);
  }

  @Put('current-task')
  @RequireCapability(TIME_TRACK_OWN)
  currentTask(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AutoTrackingView> {
    return this.service.setCurrentTask(context, principal, body);
  }

  @Post('heartbeat')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  heartbeat(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AutoTrackingView> {
    return this.service.heartbeat(context, principal, body);
  }

  @Patch('policy')
  @RequireCapability('org.manage')
  policy(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<{ readonly policy: AutoTrackingPolicy }> {
    return this.service.setPolicy(context, principal, body);
  }
}

/**
 * FIX-2026-11-10 — `/v1/organizations/:orgSlug/time/team`: everyone's tracked time, for holders of
 * `time.view_team` (owner, admins, and people an admin authorized). Read-only.
 */
@Controller('v1/organizations/:orgSlug/time/team')
export class TimeTeamController {
  constructor(@Inject(TIME_TEAM_SERVICE) private readonly service: TimeTeamService) {}

  @Get()
  @RequireCapability(TIME_VIEW_TEAM)
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('membershipId') membershipId?: string,
    @Query('projectId') projectId?: string,
  ): Promise<TeamTimeView> {
    return this.service.list(context, principal, { from, to, membershipId, projectId });
  }

  @Get(':membershipId/day')
  @RequireCapability(TIME_VIEW_TEAM)
  day(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Query('day') day?: string,
  ): Promise<TeamDayView> {
    return this.service.day(context, principal, membershipId, day);
  }
}
