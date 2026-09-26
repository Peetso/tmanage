import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  OBJECTIVE_WORK_LINKS_REPOSITORY,
  OBJECTIVE_WORK_LINKS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ObjectiveWorkLinksRepository } from './objective-work-links.repository.js';
import { ObjectiveWorkLinksService } from './objective-work-links.service.js';
import { ObjectiveWorkLinksController } from './objective-work-links.controller.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';

/**
 * PROJ / module 8 (x138). The objective→work-links module — link, list and unlink the work that
 * advances a project objective.
 *
 * Same shape as `ProjectObjectivesModule` — a stateless repository under its token, a service that
 * takes the tenant database and the repository. The service takes two more read-only, stateless
 * repositories constructed here: a `ProjectObjectivesRepository` to resolve the objective (and its
 * project) tenant-scoped before a write, and a `WorkItemsRepository` to resolve the work item in the
 * same project — so an unknown or cross-tenant id is a 404, not a foreign-key 500.
 */
@Module({})
export class ObjectiveWorkLinksModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: OBJECTIVE_WORK_LINKS_REPOSITORY,
      useFactory: () => new ObjectiveWorkLinksRepository(),
    };
    const service: Provider = {
      provide: OBJECTIVE_WORK_LINKS_SERVICE,
      inject: [TENANT_DATABASE, OBJECTIVE_WORK_LINKS_REPOSITORY],
      useFactory: (database: TenantDatabase, links: ObjectiveWorkLinksRepository) =>
        new ObjectiveWorkLinksService(
          database,
          links,
          new ProjectObjectivesRepository(),
          new WorkItemsRepository(),
        ),
    };

    return {
      module: ObjectiveWorkLinksModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ObjectiveWorkLinksController],
    };
  }
}
