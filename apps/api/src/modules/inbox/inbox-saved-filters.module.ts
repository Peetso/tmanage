import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INBOX_SAVED_FILTERS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InboxSavedFiltersService } from './inbox-saved-filters.service.js';
import { InboxSavedFiltersController } from './inbox-saved-filters.controller.js';

/**
 * INBOX saved filters (IN-02 "All inbox", x261). The saved-inbox-filter slice's vertical: a stateless
 * service over the tenant database and one controller. Same shape as `SavedSearchesModule` — the
 * service takes the tenant database and constructs its own repository. Registered separately from
 * `InboxModule` (which is `.register()`-based and would build a second copy of itself if imported).
 */
@Module({})
export class InboxSavedFiltersModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INBOX_SAVED_FILTERS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new InboxSavedFiltersService(database),
    };

    return {
      module: InboxSavedFiltersModule,
      providers: [service],
      exports: [service],
      controllers: [InboxSavedFiltersController],
    };
  }
}
