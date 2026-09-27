import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SAVED_SEARCHES_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SavedSearchesService } from './saved-searches.service.js';
import { SavedSearchesController } from './saved-searches.controller.js';

/**
 * SRCH saved/recent searches (x214). The saved & recent search slice's vertical: a stateless
 * service over the tenant database and one controller. Same shape as `WorkViewsModule` — the service
 * takes the tenant database and constructs its own repository. The service is exported so the search
 * module can record a recent query after a successful global search.
 */
@Module({})
export class SavedSearchesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SAVED_SEARCHES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new SavedSearchesService(database),
    };

    return {
      module: SavedSearchesModule,
      providers: [service],
      exports: [service],
      controllers: [SavedSearchesController],
    };
  }
}
