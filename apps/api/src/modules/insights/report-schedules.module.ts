import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INSIGHT_REPORT_SCHEDULES_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightReportSchedulesController } from './report-schedules.controller.js';
import { InsightReportSchedulesService } from './report-schedules.service.js';

/**
 * INS report schedules wiring (module 15, x228).
 *
 * A service and the caller's-own create/list/delete routes over `TENANT_DATABASE`. Kept in a module
 * of its own — file-disjoint from the read-only `InsightsModule`, the saved views and the snapshots —
 * so neither slice edits a file the other appends to. The controller depends only on this service; the
 * service depends only on the global tenant database. Every provider carries an explicit token
 * (ADR-0003).
 */
@Module({})
export class InsightReportSchedulesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_REPORT_SCHEDULES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InsightReportSchedulesService(database),
    };

    return {
      module: InsightReportSchedulesModule,
      providers: [service],
      controllers: [InsightReportSchedulesController],
    };
  }
}
