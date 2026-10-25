import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  PlanUsagePreviewView,
  PlanUsageService,
  PlanUsageView,
} from './plan-usage.service.js';

/** Slice-private token (the plan-change-requests posture), so `tokens.ts` stays untouched. */
export const PLAN_USAGE_SERVICE = Symbol.for('tmanage.PlanUsageService');

/**
 * Plan and usage — Figma F4. Two org-scoped reads under `…/organizations/:orgSlug/billing/plan-usage`,
 * both behind `org.manage` (re-checked in the service). The tenant is the {@link TenantContext} the
 * guard resolved from a membership row; nothing here reads an organization id from the request.
 * Nothing is written and nothing is charged.
 */
@Controller('v1/organizations/:orgSlug/billing/plan-usage')
export class PlanUsageController {
  constructor(@Inject(PLAN_USAGE_SERVICE) private readonly plans: PlanUsageService) {}

  /** The current plan, its limits and the usage against them. */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PlanUsageView> {
    return this.plans.read(context, principal);
  }

  /** What changing to `target` would do: price, start, due today, gains, losses, overages. */
  @Get('preview')
  @RequireCapability('org.manage')
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('target') target?: string,
  ): Promise<PlanUsagePreviewView> {
    return this.plans.preview(context, principal, typeof target === 'string' ? target.trim() : '');
  }
}
