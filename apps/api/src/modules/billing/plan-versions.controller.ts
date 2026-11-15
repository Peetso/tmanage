import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  RequireCapability,
} from '../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import type {
  PlanVersionView,
  PlanVersionsService,
  WorkspacePlanView,
} from './plan-versions.service.js';

/** Slice-private token (the plan-usage posture), so `tokens.ts` stays untouched. */
export const PLAN_VERSIONS_SERVICE = Symbol.for('tmanage.PlanVersionsService');

/**
 * `/v1/platform/plan-versions` — 57-02. The Platform admin reads the plan ladder and publishes a new
 * version (super admin, re-checked in the service). No organization in the path or the body.
 */
@Controller('v1/platform/plan-versions')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformPlanVersionsController {
  constructor(@Inject(PLAN_VERSIONS_SERVICE) private readonly plans: PlanVersionsService) {}

  @Get()
  @RequirePlatformPermission('platform.orgs.view')
  list(@Req() request: object): Promise<readonly PlanVersionView[]> {
    return this.plans.list(platformRequestContext(request));
  }

  @Post()
  @RequirePlatformPermission('platform.settings.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>>,
    @Req() request: object,
  ): Promise<PlanVersionView> {
    return this.plans.create(actor, body ?? {}, platformRequestContext(request));
  }
}

/**
 * `…/organizations/:orgSlug/billing/plan` — 57-02. The workspace's own current plan, behind
 * `billing.view` (re-checked in the service). The tenant is the guard's {@link TenantContext};
 * nothing here reads an organization id from the request, and nothing is written.
 */
@Controller('v1/organizations/:orgSlug/billing/plan')
export class WorkspacePlanController {
  constructor(@Inject(PLAN_VERSIONS_SERVICE) private readonly plans: PlanVersionsService) {}

  @Get()
  @RequireCapability('billing.view')
  current(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspacePlanView> {
    return this.plans.current(context, principal);
  }
}
