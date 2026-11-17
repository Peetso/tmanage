import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { CsvHeaderWriter } from './insights-export.controller.js';
import type {
  FinanceReportsService,
  ProfitabilityView,
  RebuildView,
  UnbilledView,
  UtilisationView,
} from './finance-reports.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const FINANCE_REPORTS_SERVICE = Symbol.for('tmanage.FinanceReportsService');

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * 52-14 (R17-a) — `/v1/organizations/:orgSlug/insights/finance/*`: profitability, unbilled and
 * utilisation reads, their CSV, and the on-demand facts rebuild. Org-internal; never an AI tool.
 *
 * Capabilities (no `capabilities.ts` edit): the plan's `finance.report` is `finance.view`; the
 * plan's `rate.view_cost` is `finance.manage` — the stand-in `rates.controller.ts` uses — and the
 * service omits cost and margin keys without it. The CSV is `report.export` here and
 * `finance.view` in the service. The rebuild is `finance.manage`, charged per organization
 * (`orgSlug`) by the durable throttle and held to once per 5 minutes by the service from the
 * newest `computed_at`.
 */
@RequireFeature('finance_reports')
@Controller('v1/organizations/:orgSlug/insights/finance')
export class FinanceReportsController {
  constructor(@Inject(FINANCE_REPORTS_SERVICE) private readonly service: FinanceReportsService) {}

  @Get('profitability')
  @RequireCapability('finance.view')
  profitability(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('by') by?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ProfitabilityView> {
    return this.service.profitability(context, principal, { by, from, to });
  }

  @Get('unbilled')
  @RequireCapability('finance.view')
  unbilled(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('by') by?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<UnbilledView> {
    return this.service.unbilled(context, principal, { by, from, to });
  }

  @Get('utilisation')
  @RequireCapability('finance.view')
  utilisation(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('after') after?: string,
  ): Promise<UtilisationView> {
    return this.service.utilisation(context, principal, { from, to, after });
  }

  @Get('export.csv')
  @RequireCapability('report.export')
  async exportCsv(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: CsvHeaderWriter,
    @Query('report') report?: string,
    @Query('by') by?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StreamableFile> {
    const csv = await this.service.exportCsv(context, principal, { report, by, from, to });
    const body = Buffer.from(csv.body, 'utf8');
    reply.header('content-type', CSV_CONTENT_TYPE);
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${csv.filename}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: CSV_CONTENT_TYPE, length: body.byteLength });
  }

  @Post('facts/rebuild')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  @Throttle('finance_facts_rebuild', {
    perMinute: 1,
    perHour: 12,
    key: 'link',
    linkParam: 'orgSlug',
    onStoreError: 'open',
  })
  rebuild(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RebuildView> {
    return this.service.rebuild(context, principal);
  }
}
