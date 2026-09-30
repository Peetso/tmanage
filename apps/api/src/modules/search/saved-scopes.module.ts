import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SEARCH_SCOPES_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchScopesService } from './saved-scopes.service.js';
import { SearchScopesController } from './saved-scopes.controller.js';

/**
 * SRCH saved scopes (x334). The saved-scope slice's vertical: a stateless service over the tenant
 * database and one controller. Same shape as `SavedSearchesModule` — the service takes the tenant
 * database and constructs its own repository and project resolver. A separate module from
 * `SavedSearchesModule`/`SavedSearchSharesModule` so the search slices stay file-disjoint.
 */
@Module({})
export class SearchScopesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SEARCH_SCOPES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SearchScopesService(database),
    };

    return {
      module: SearchScopesModule,
      providers: [service],
      exports: [service],
      controllers: [SearchScopesController],
    };
  }
}
