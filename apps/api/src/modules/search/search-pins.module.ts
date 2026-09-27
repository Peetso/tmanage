import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SEARCH_PINS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchPinsService } from './search-pins.service.js';
import { SearchPinsController } from './search-pins.controller.js';

/**
 * SRCH quick-access pins (x290). The pins slice's vertical: a stateless service over the tenant
 * database and one controller. Same shape as `SavedSearchesModule` — the service takes the tenant
 * database and constructs its own repository. A module of its own beside `SearchModule` and
 * `SavedSearchesModule` so the search slices stay file-disjoint; it shares the `search.use` gate the
 * other search reads use, so it adds no capability.
 */
@Module({})
export class SearchPinsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SEARCH_PINS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SearchPinsService(database),
    };

    return {
      module: SearchPinsModule,
      providers: [service],
      exports: [service],
      controllers: [SearchPinsController],
    };
  }
}
