import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  CostRateView,
  RateCardView,
  RateEntryView,
  RatesService,
  ResolvedRateView,
} from './rates.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const RATES_SERVICE = Symbol.for('tmanage.RatesService');

/**
 * 52-04 — `/v1/organizations/:orgSlug/finance`: rate cards and entries, the resolver, member cost
 * rates, re-pricing and the project assignment. Sell rates read `finance.view` and write
 * `finance.manage`. Cost rates read AND write `finance.manage`: the stand-in for the plan's
 * `rate.view_cost` (52-23 rule — no new capability key here), so a Manager holding only
 * `finance.view` never sees a cost figure. The service asks the same capability again.
 */
@RequireFeature('finance_rates_budgets')
@Controller('v1/organizations/:orgSlug/finance')
export class RatesController {
  constructor(@Inject(RATES_SERVICE) private readonly service: RatesService) {}

  @Get('rate-cards')
  @RequireCapability('finance.view')
  async listCards(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly rateCards: readonly RateCardView[] }> {
    return { rateCards: await this.service.listCards(context, principal) };
  }

  @Post('rate-cards')
  @RequireCapability('finance.manage')
  createCard(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<RateCardView> {
    return this.service.createCard(context, principal, body);
  }

  /** Static segment: matched before `rate-cards/:rateCardId`. */
  @Put('rate-cards/assign')
  @RequireCapability('finance.manage')
  assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<{
    readonly projectId: string;
    readonly rateCardId: string | null;
    readonly billableDefault: boolean;
  }> {
    return this.service.assign(context, principal, body);
  }

  @Put('rate-cards/:rateCardId')
  @RequireCapability('finance.manage')
  updateCard(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('rateCardId') rateCardId: string,
    @Body() body: unknown,
  ): Promise<RateCardView> {
    return this.service.updateCard(context, principal, rateCardId, body);
  }

  @Get('rate-cards/:rateCardId/entries')
  @RequireCapability('finance.view')
  async listEntries(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('rateCardId') rateCardId: string,
  ): Promise<{ readonly entries: readonly RateEntryView[] }> {
    return { entries: await this.service.listEntries(context, principal, rateCardId) };
  }

  @Post('rate-cards/:rateCardId/entries')
  @RequireCapability('finance.manage')
  addEntry(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('rateCardId') rateCardId: string,
    @Body() body: unknown,
  ): Promise<RateEntryView> {
    return this.service.addEntry(context, principal, rateCardId, body);
  }

  @Delete('rate-cards/:rateCardId/entries/:entryId')
  @HttpCode(204)
  @RequireCapability('finance.manage')
  async removeEntry(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('rateCardId') rateCardId: string,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    await this.service.removeEntry(context, principal, rateCardId, entryId);
  }

  @Get('rates/resolve')
  @RequireCapability('finance.view')
  resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('membershipId') membershipId?: string,
    @Query('on') on?: string,
  ): Promise<ResolvedRateView> {
    return this.service.resolve(context, principal, { projectId, membershipId, on });
  }

  @Post('rates/reprice')
  @RequireCapability('finance.manage')
  reprice(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<{ readonly repriced: number }> {
    return this.service.reprice(context, principal, body);
  }

  /** Cost rates: `finance.manage` for read too (stand-in for `rate.view_cost`). */
  @Get('cost-rates/:membershipId')
  @RequireCapability('finance.manage')
  getCostRates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<CostRateView> {
    return this.service.getCostRates(context, principal, membershipId);
  }

  @Put('cost-rates/:membershipId')
  @RequireCapability('finance.manage')
  putCostRate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<CostRateView> {
    return this.service.putCostRate(context, principal, membershipId, body);
  }
}
