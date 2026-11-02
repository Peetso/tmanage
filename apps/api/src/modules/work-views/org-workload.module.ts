import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { PersonLoadRepository } from '../people/person-load.repository.js';
import { OrgWorkloadRepository } from './org-workload.repository.js';
import { OrgWorkloadService } from './org-workload.service.js';
import { OrgWorkloadController } from './org-workload.controller.js';

/**
 * 53-08 part 2a (R21-a) — the org-wide workload grid's wiring. Stateless repositories constructed
 * here and no service export (the work-views.module.ts pattern), so that module is not edited.
 */
@Module({})
export class OrgWorkloadModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: OrgWorkloadService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new OrgWorkloadService(
          database,
          new OrgWorkloadRepository(),
          new PersonLoadRepository(),
          new ProjectsRepository(),
        ),
    };
    return {
      module: OrgWorkloadModule,
      providers: [service],
      controllers: [OrgWorkloadController],
    };
  }
}
