import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MILESTONE_LINKS_REPOSITORY,
  MILESTONE_LINKS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { MilestoneLinksRepository } from './milestone-links.repository.js';
import { MilestoneLinksService } from './milestone-links.service.js';
import { MilestoneLinksController } from './milestone-links.controller.js';

/**
 * PROJ / module 8 (x236). The milestone-dependencies module — link, list and unlink the milestones a
 * project milestone depends on.
 *
 * Same shape as `ObjectiveWorkLinksModule` — a stateless repository under its token, a service that
 * takes the tenant database and the repository. The service takes one more read-only, stateless
 * repository constructed here: a `ProjectMilestonesRepository` to resolve both milestone ids
 * tenant-scoped (and in the same project) before a write, so an unknown or cross-tenant id is a 404,
 * not a foreign-key 500.
 */
@Module({})
export class MilestoneLinksModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MILESTONE_LINKS_REPOSITORY,
      useFactory: () => new MilestoneLinksRepository(),
    };
    const service: Provider = {
      provide: MILESTONE_LINKS_SERVICE,
      inject: [TENANT_DATABASE, MILESTONE_LINKS_REPOSITORY],
      useFactory: (database: TenantDatabase, links: MilestoneLinksRepository) =>
        new MilestoneLinksService(database, links, new ProjectMilestonesRepository()),
    };

    return {
      module: MilestoneLinksModule,
      providers: [repository, service],
      exports: [service],
      controllers: [MilestoneLinksController],
    };
  }
}
