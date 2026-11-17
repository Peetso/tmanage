import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  RetainerEntryView,
  RetainerPeriodView,
  RetainerView,
  RetainersService,
} from './retainers.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const RETAINERS_SERVICE = Symbol.for('tmanage.RetainersService');

/**
 * 52-06 — retainers under `/v1/organizations/:orgSlug`. Capability stand-ins (no `capabilities.ts`
 * edit): `retainer.manage` → `finance.manage`; `retainer.view` → `finance.view` (full) or
 * `work.read` with a relation to a covered project (hours only: no `amountPerPeriodMinor` /
 * `currency`). The service re-checks each against the row. Org-internal; the client reads only the
 * projection in `portal/portal-retainers.controller.ts`. 52-09 is not built, so there is no
 * "Invoice this period" route yet.
 */
@RequireFeature('finance_rates_budgets')
@Controller('v1/organizations/:orgSlug')
export class RetainersController {
  constructor(@Inject(RETAINERS_SERVICE) private readonly service: RetainersService) {}

  @Get('client-organizations/:clientOrganizationId/retainers')
  @RequireCapability('work.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<{ readonly retainers: readonly RetainerView[] }> {
    return this.service.listForClient(context, principal, clientOrganizationId);
  }

  @Post('client-organizations/:clientOrganizationId/retainers')
  @HttpCode(201)
  @RequireCapability('finance.manage')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
    @Body() body: unknown,
  ): Promise<RetainerView> {
    return this.service.create(context, principal, clientOrganizationId, body);
  }

  @Get('retainers/:retainerId')
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<RetainerView> {
    return this.service.get(context, principal, retainerId);
  }

  @Put('retainers/:retainerId')
  @RequireCapability('finance.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
    @Body() body: unknown,
  ): Promise<RetainerView> {
    return this.service.update(context, principal, retainerId, body);
  }

  @Post('retainers/:retainerId/pause')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  pause(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<RetainerView> {
    return this.service.transition(context, principal, retainerId, 'pause');
  }

  @Post('retainers/:retainerId/resume')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  resume(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<RetainerView> {
    return this.service.transition(context, principal, retainerId, 'resume');
  }

  @Post('retainers/:retainerId/end')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  end(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<RetainerView> {
    return this.service.transition(context, principal, retainerId, 'end');
  }

  @Get('retainers/:retainerId/periods')
  @RequireCapability('work.read')
  periods(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
  ): Promise<{ readonly retainerId: string; readonly periods: readonly RetainerPeriodView[] }> {
    return this.service.periods(context, principal, retainerId);
  }

  @Get('retainers/:retainerId/periods/:periodId/entries')
  @RequireCapability('work.read')
  entries(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('retainerId') retainerId: string,
    @Param('periodId') periodId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly entries: readonly RetainerEntryView[];
    readonly nextCursor: string | null;
  }> {
    return this.service.entries(context, principal, retainerId, periodId, query);
  }
}
