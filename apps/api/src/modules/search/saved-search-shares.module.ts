import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SAVED_SEARCH_SHARES_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SavedSearchSharesService } from './saved-search-shares.service.js';
import { SavedSearchSharesController } from './saved-search-shares.controller.js';

/**
 * SRCH saved-search sharing (x272). The sharing slice's vertical: a stateless service over the
 * tenant database and one controller. Same shape as `SavedSearchesModule` (x214) — the service takes
 * the tenant database and constructs its own repository — but a separate module and controller, so
 * the sharing half never edits the x214 saved-searches files.
 */
@Module({})
export class SavedSearchSharesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SAVED_SEARCH_SHARES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SavedSearchSharesService(database),
    };

    return {
      module: SavedSearchSharesModule,
      providers: [service],
      exports: [service],
      controllers: [SavedSearchSharesController],
    };
  }
}
