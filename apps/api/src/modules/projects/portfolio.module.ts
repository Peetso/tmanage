import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_PORTFOLIO_REPOSITORY,
  PROJECT_PORTFOLIO_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectPortfolioRepository } from './portfolio.repository.js';
import { ProjectPortfolioService } from './portfolio.service.js';
import { ProjectPortfolioController } from './portfolio.controller.js';
import { ProjectPortfolioCapacityService } from './portfolio-capacity.service.js';

/**
 * PROJ / module 8 (x137). The project-portfolio module — the read-only roll-up across the caller's
 * visible projects.
 *
 * Same shape as the sibling read modules: a stateless repository under its token and a service that
 * takes the tenant database, a read-only `ProjectsRepository` (to list the tenant's projects for the
 * relation filter), and the portfolio aggregate repository. No new table, so nothing to register in
 * the schema/tenant-guard/grant/migrator quartet.
 */
@Module({})
export class ProjectPortfolioModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_PORTFOLIO_REPOSITORY,
      useFactory: () => new ProjectPortfolioRepository(),
    };
    const service: Provider = {
      provide: PROJECT_PORTFOLIO_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_PORTFOLIO_REPOSITORY],
      useFactory: (database: TenantDatabase, portfolio: ProjectPortfolioRepository) =>
        new ProjectPortfolioService(database, new ProjectsRepository(), portfolio),
    };

    const capacity: Provider = {
      provide: ProjectPortfolioCapacityService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new ProjectPortfolioCapacityService(database),
    };

    return {
      module: ProjectPortfolioModule,
      providers: [repository, service, capacity],
      exports: [service],
      controllers: [ProjectPortfolioController],
    };
  }
}
