import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  CostCenterReportService,
  type CostCenterReportRowView,
} from './cost-center-report.service.js';

/**
 * Billing & entitlements (module 19, x331). The spend-by-cost-centre report: for each cost centre a
 * billing admin defined (x281), the count of assigned projects and their summed budget (x293). One
 * route, read-only, behind `org.manage` — the same capability its cost-centres and usage-alerts
 * siblings reuse (no billing capability exists and this slice adds none).
 *
 * The controller is the thin HTTP boundary: it carries no request body (a `GET`), so there is nothing
 * to validate, and it delegates the tenant-scoping and the authoritative authorization decision to
 * {@link CostCenterReportService}. A caller without `org.manage` gets a 403 before any row is read; an
 * unknown or empty tenant answers `200` with an empty list.
 */

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed. */
const COST_CENTER_REPORT_SERVICE = Symbol.for('tmanage.CostCenterReportService');

@Controller('v1/organizations/:orgSlug/billing/cost-center-report')
export class CostCenterReportController {
  constructor(
    @Inject(COST_CENTER_REPORT_SERVICE) private readonly reports: CostCenterReportService,
  ) {}

  /** The acting tenant's spend-by-cost-centre roll-up, code-ascending. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async report(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly costCenters: readonly CostCenterReportRowView[] }> {
    return { costCenters: await this.reports.report(context, principal) };
  }
}

/**
 * Billing & entitlements (module 19, x331). The module that wires the controller and its service.
 * Registered in `app.module.ts` directly, beside the cost-centres module, so this slice touches no file
 * another billing slice appends to beyond that one registration line. It reuses `org.manage`, so it
 * adds nothing to the capability files.
 */
@Module({})
export class CostCenterReportModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: COST_CENTER_REPORT_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new CostCenterReportService(database),
    };

    return {
      module: CostCenterReportModule,
      providers: [service],
      controllers: [CostCenterReportController],
    };
  }
}
