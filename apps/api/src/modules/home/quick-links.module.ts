import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  HOME_QUICK_LINKS_REPOSITORY,
  HOME_QUICK_LINKS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { HomeQuickLinksController } from './quick-links.controller.js';
import { HomeQuickLinksRepository } from './quick-links.repository.js';
import { HomeQuickLinksService } from './quick-links.service.js';

/**
 * Home quick-links wiring (module 4 Home / My Day, x273).
 *
 * A repository, a service over `TENANT_DATABASE`, and the caller's-own CRUD route. Kept in a module
 * of its own — file-disjoint from the rest of the Home module — so this slice edits no file another
 * Home slice appends to. The controller depends only on the service; the service depends on the
 * global tenant database and the repository. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class HomeQuickLinksModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: HOME_QUICK_LINKS_REPOSITORY,
      useFactory: () => new HomeQuickLinksRepository(),
    };
    const service: Provider = {
      provide: HOME_QUICK_LINKS_SERVICE,
      useFactory: (database: TenantDatabase, repo: HomeQuickLinksRepository) =>
        new HomeQuickLinksService(database, repo),
      inject: [TENANT_DATABASE, HOME_QUICK_LINKS_REPOSITORY],
    };

    return {
      module: HomeQuickLinksModule,
      providers: [repository, service],
      controllers: [HomeQuickLinksController],
    };
  }
}
