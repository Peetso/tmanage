import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { SEARCH_REPOSITORY, SEARCH_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchRepository } from './search.repository.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';

/**
 * SRCH-01 (x111). The search module's first (and only, this slice) vertical slice: global
 * tenant-scoped read over work items, documents and meetings.
 *
 * Same shape as `CalendarModule`/`DocsModule` — a stateless repository under its token, a service
 * that takes the tenant database and the repository, and one controller. It also takes a second,
 * read-only `ProjectsRepository`, constructed here as the sibling modules construct theirs: the
 * service uses it only to resolve an optional `projectId` filter inside the tenant before the
 * search, so an unknown or cross-tenant id is a 404, not an empty result set (Known-trap).
 */
@Module({})
export class SearchModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: SEARCH_REPOSITORY,
      useFactory: () => new SearchRepository(),
    };
    const service: Provider = {
      provide: SEARCH_SERVICE,
      inject: [TENANT_DATABASE, SEARCH_REPOSITORY],
      useFactory: (database: TenantDatabase, search: SearchRepository) =>
        new SearchService(database, search, new ProjectsRepository()),
    };

    return {
      module: SearchModule,
      providers: [repository, service],
      exports: [service],
      controllers: [SearchController],
    };
  }
}
