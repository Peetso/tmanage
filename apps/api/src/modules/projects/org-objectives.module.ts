import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  ORG_OBJECTIVES_REPOSITORY,
  ORG_OBJECTIVES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { OrgObjectivesRepository } from './org-objectives.repository.js';
import { OrgObjectivesService } from './org-objectives.service.js';
import { OrgObjectivesController } from './org-objectives.controller.js';

/**
 * PROJ / module 8 (x136). The org-objectives module — an organization's objectives (create, list,
 * transition).
 *
 * Same shape as `ProjectObjectivesModule` (x124) — a stateless repository under its token, a service
 * that takes the tenant database and the repository, and one controller. Unlike x124 there is no
 * second repository: an org objective belongs to the tenant, not to a project, so there is no project
 * to resolve before a write.
 */
@Module({})
export class OrgObjectivesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: ORG_OBJECTIVES_REPOSITORY,
      useFactory: () => new OrgObjectivesRepository(),
    };
    const service: Provider = {
      provide: ORG_OBJECTIVES_SERVICE,
      inject: [TENANT_DATABASE, ORG_OBJECTIVES_REPOSITORY],
      useFactory: (database: TenantDatabase, objectives: OrgObjectivesRepository) =>
        new OrgObjectivesService(database, objectives),
    };

    return {
      module: OrgObjectivesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [OrgObjectivesController],
    };
  }
}
