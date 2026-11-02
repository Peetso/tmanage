import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { FinanceReadiness } from './finance-rules.js';
import type {
  ExchangeRateView,
  FinanceProfileView,
  FinanceService,
  TaxDocumentRulesView,
  TaxRateView,
} from './finance.service.js';

export const FINANCE_SERVICE = Symbol.for('tmanage.FinanceService');

/**
 * 52-23 — `/v1/organizations/:orgSlug/finance`: profile, tax rates, manual exchange rates and the
 * readiness check, and (52-28) the tax-document rules (`finance.view`; the profile's VAT status and
 * e-invoice regime are written by the profile PUT, `finance.manage`). The route guard asks the
 * capability the service asks again at organization scope (`finance.manage` to write,
 * `finance.view` to read — see `finance.service.ts`). No public route.
 */
@Controller('v1/organizations/:orgSlug/finance')
export class FinanceController {
  constructor(@Inject(FINANCE_SERVICE) private readonly service: FinanceService) {}

  @Get('profile')
  @RequireCapability('finance.view')
  getProfile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FinanceProfileView> {
    return this.service.getProfile(context, principal);
  }

  @Put('profile')
  @RequireCapability('finance.manage')
  updateProfile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<FinanceProfileView> {
    return this.service.updateProfile(context, principal, body);
  }

  @Get('tax-rates')
  @RequireCapability('finance.view')
  async listTaxRates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly taxRates: readonly TaxRateView[] }> {
    return { taxRates: await this.service.listTaxRates(context, principal) };
  }

  @Post('tax-rates')
  @RequireCapability('finance.manage')
  createTaxRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TaxRateView> {
    return this.service.createTaxRate(context, principal, body);
  }

  @Put('tax-rates/:taxRateId')
  @RequireCapability('finance.manage')
  updateTaxRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('taxRateId') taxRateId: string,
    @Body() body: unknown,
  ): Promise<TaxRateView> {
    return this.service.updateTaxRate(context, principal, taxRateId, body);
  }

  @Get('exchange-rates')
  @RequireCapability('finance.view')
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
  @RequireCapability('finance.manage')
  createExchangeRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<ExchangeRateView> {
    return this.service.createExchangeRate(context, principal, body);
  }

  /** 52-28 — the tax-document rules for this organization's country and VAT status. */
  @Get('tax-document-rules')
  @RequireCapability('finance.view')
  taxDocumentRules(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TaxDocumentRulesView> {
    return this.service.taxDocumentRules(context, principal);
  }

  @Get('readiness')
  @RequireCapability('finance.view')
  readiness(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FinanceReadiness> {
    return this.service.readiness(context, principal);
  }
}
