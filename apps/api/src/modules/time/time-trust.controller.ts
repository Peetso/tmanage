import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { RequireFeature } from '../admin/feature-gate.js';
import { TIME_MANAGE_ANY, TIME_TRACK_OWN } from './time-capabilities.js';
import type {
  TimeApprovalQueueView,
  TimeEntryHistoryView,
  TimeTrustEntryView,
  TimeTrustPolicyView,
  TimeTrustService,
} from './time-trust.service.js';

export const TIME_TRUST_SERVICE = Symbol.for('tmanage.TimeTrustService');

/**
 * Time you can trust (owner rule, 2026-11-23) — `/v1/organizations/:orgSlug/time/…`.
 *
 * - `trust-policy`: every internal member reads it (the screens explain why "Log time" is off);
 *   only the company owner changes it (`org.manage` here, the owner role in the service).
 * - `approvals`: the managers' queue and the two decisions (`project.manage` here; the service
 *   asks per entry, never one's own).
 * - `entries/:id/correction` and `entries/:id/history`: a member on their own entry, or a manager
 *   on one they may decide (the service answers 404 otherwise).
 *
 * Org-internal: no portal or public route.
 */
@RequireFeature('time_tracking')
@Controller('v1/organizations/:orgSlug/time')
export class TimeTrustController {
  constructor(@Inject(TIME_TRUST_SERVICE) private readonly service: TimeTrustService) {}

  @Get('trust-policy')
  @RequireCapability(TIME_TRACK_OWN)
  policy(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TimeTrustPolicyView> {
    return this.service.policy(context, principal);
  }

  @Patch('trust-policy')
  @RequireCapability('org.manage')
  setPolicy(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TimeTrustPolicyView> {
    return this.service.setPolicy(context, principal, body);
  }

  @Get('approvals')
  @RequireCapability(TIME_MANAGE_ANY)
  queue(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TimeApprovalQueueView> {
    return this.service.queue(context, principal);
  }

  @Post('approvals/:entryId/approve')
  @RequireCapability(TIME_MANAGE_ANY)
  @HttpCode(200)
  approve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('entryId') entryId: string,
    @Body() body: unknown,
  ): Promise<TimeTrustEntryView> {
    return this.service.decide(context, principal, entryId, body, true);
  }

  @Post('approvals/:entryId/reject')
  @RequireCapability(TIME_MANAGE_ANY)
  @HttpCode(200)
  reject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('entryId') entryId: string,
    @Body() body: unknown,
  ): Promise<TimeTrustEntryView> {
    return this.service.decide(context, principal, entryId, body, false);
  }

  @Post('entries/:entryId/correction')
  @RequireCapability(TIME_TRACK_OWN)
  correction(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('entryId') entryId: string,
    @Body() body: unknown,
  ): Promise<TimeTrustEntryView> {
    return this.service.requestCorrection(context, principal, entryId, body);
  }

  @Get('entries/:entryId/history')
  @RequireCapability(TIME_TRACK_OWN)
  history(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('entryId') entryId: string,
  ): Promise<TimeEntryHistoryView> {
    return this.service.history(context, principal, entryId);
  }
}
