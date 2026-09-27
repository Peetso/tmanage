import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INSIGHT_SAVED_VIEWS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightSavedViewsController } from './saved-views.controller.js';
import { InsightSavedViewsService } from './saved-views.service.js';

/**
 * INS saved views wiring (module 15, x210).
 *
 * A service and the caller's-own create/list/delete routes over `TENANT_DATABASE`. Kept in a module
 * of its own — file-disjoint from the read-only `InsightsModule` (x109…) — so neither slice edits a
 * file the other appends to. The controller depends only on this service; the service depends only on
 * the global tenant database. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class SavedInsightViewsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHT_SAVED_VIEWS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InsightSavedViewsService(database),
    };

    return {
      module: SavedInsightViewsModule,
      providers: [service],
      controllers: [InsightSavedViewsController],
    };
  }
}
