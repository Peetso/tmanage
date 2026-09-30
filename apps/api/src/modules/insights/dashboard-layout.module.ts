import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INSIGHT_DASHBOARD_LAYOUT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightDashboardLayoutController } from './dashboard-layout.controller.js';
import { InsightDashboardLayoutRepository } from './dashboard-layout.repository.js';
import { InsightDashboardLayoutService } from './dashboard-layout.service.js';

/**
 * Per-user insight-dashboard-layout wiring (module 16 Insights, x302).
 *
 * A service and the caller's-own GET/PUT route over `TENANT_DATABASE`. A separate module from
 * `InsightsModule` — file-disjoint from the rest of the insights module, the choice the sibling
 * insights slices (`SavedInsightViewsModule`, `WorkloadForecastModule`, `InsightSnapshotsModule`)
 * document — so this slice edits no file another insights slice appends to. The service depends only
 * on the global tenant database and its stateless repository; there is no tenant object to resolve.
 * Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class InsightDashboardLayoutModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_DASHBOARD_LAYOUT_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightDashboardLayoutService(database, new InsightDashboardLayoutRepository()),
    };

    return {
      module: InsightDashboardLayoutModule,
      providers: [service],
      controllers: [InsightDashboardLayoutController],
    };
  }
}
