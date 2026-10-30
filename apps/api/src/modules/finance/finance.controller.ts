import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { FinanceReadiness } from './finance-rules.js';
import type {
  ExchangeRateView,
  FinanceProfileView,
  FinanceService,
  TaxRateView,
} from './finance.service.js';

export const FINANCE_SERVICE = Symbol.for('tmanage.FinanceService');

/**
 * 52-23 — `/v1/organizations/:orgSlug/finance`: profile, tax rates, manual exchange rates and the
 * readiness check. The route guard asks the capability the service asks again at organization
 * scope (`workspace.manage` to write, `project.manage` to read, standing in for `finance.manage`
 * / `finance.view` — see `finance.service.ts`). No public route.
 */
@Controller('v1/organizations/:orgSlug/finance')
export class FinanceController {
  constructor(@Inject(FINANCE_SERVICE) private readonly service: FinanceService) {}

  @Get('profile')
  @RequireCapability('project.manage')
  getProfile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FinanceProfileView> {
    return this.service.getProfile(context, principal);
  }

  @Put('profile')
  @RequireCapability('workspace.manage')
  updateProfile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<FinanceProfileView> {
    return this.service.updateProfile(context, principal, body);
  }

  @Get('tax-rates')
  @RequireCapability('project.manage')
  async listTaxRates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly taxRates: readonly TaxRateView[] }> {
    return { taxRates: await this.service.listTaxRates(context, principal) };
  }

  @Post('tax-rates')
  @RequireCapability('workspace.manage')
  createTaxRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TaxRateView> {
    return this.service.createTaxRate(context, principal, body);
  }

  @Put('tax-rates/:taxRateId')
  @RequireCapability('workspace.manage')
  updateTaxRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('taxRateId') taxRateId: string,
    @Body() body: unknown,
  ): Promise<TaxRateView> {
    return this.service.updateTaxRate(context, principal, taxRateId, body);
  }

  @Get('exchange-rates')
  @RequireCapability('project.manage')
  async listExchangeRates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly exchangeRates: readonly ExchangeRateView[] }> {
    return {
      exchangeRates: await this.service.listExchangeRates(context, principal, { from, to, limit }),
    };
  }

  @Post('exchange-rates')
  @RequireCapability('workspace.manage')
  createExchangeRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<ExchangeRateView> {
    return this.service.createExchangeRate(context, principal, body);
  }

  @Get('readiness')
  @RequireCapability('project.manage')
  readiness(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FinanceReadiness> {
    return this.service.readiness(context, principal);
  }
}
