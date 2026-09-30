import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SEARCH_HISTORY_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchHistoryService } from './search-history.service.js';
import { SearchHistoryController } from './search-history.controller.js';

/**
 * Search recent history (x288). The recent-search-history slice's vertical: a stateless service over
 * the tenant database and one controller. Same shape as `SavedSearchesModule` — the service takes
 * the tenant database and constructs its own repository. A separate module from `SearchModule` and
 * `SavedSearchesModule` so the search slices stay file-disjoint.
 */
@Module({})
export class SearchHistoryModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SEARCH_HISTORY_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SearchHistoryService(database),
    };

    return {
      module: SearchHistoryModule,
      providers: [service],
      exports: [service],
      controllers: [SearchHistoryController],
    };
  }
}
