import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  IMPORT_JOBS_REPOSITORY,
  IMPORT_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ImportJobsRepository } from './import-jobs.repository.js';
import { ImportRowsRepository } from './import-rows.repository.js';
import { ImportService } from './import.service.js';
import { ImportController } from './import.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';

/**
 * ON-09. The onboarding-import module — validate / dry-run half (x95) plus the commit half (x100).
 *
 * The commit half creates target entities, so the service now wires the `import_rows` receipt
 * repository and the projects repository alongside the tenant database and `import_jobs`. The
 * per-row `project.create` `authorize()` in the service — not a wiring choice — is what keeps a
 * commit no broader than a manual create.
 */
@Module({})
export class ImportModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: IMPORT_JOBS_REPOSITORY,
      useFactory: () => new ImportJobsRepository(),
    };
    const service: Provider = {
      provide: IMPORT_SERVICE,
      inject: [TENANT_DATABASE, IMPORT_JOBS_REPOSITORY],
      useFactory: (database: TenantDatabase, jobs: ImportJobsRepository) =>
        new ImportService(database, jobs, new ImportRowsRepository(), new ProjectsRepository()),
    };

    return {
      module: ImportModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ImportController],
    };
  }
}
