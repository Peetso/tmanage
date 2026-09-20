import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  IMPORT_JOBS_REPOSITORY,
  IMPORT_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ImportJobsRepository } from './import-jobs.repository.js';
import { ImportService } from './import.service.js';
import { ImportController } from './import.controller.js';

/**
 * ON-09. The onboarding-import module — validate / dry-run half.
 *
 * The service depends on the tenant database and the `import_jobs` repository only; it wires no
 * projects/work repository, which is what makes "commits no target entity" a property of the
 * graph rather than a promise in a comment.
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
        new ImportService(database, jobs),
    };

    return {
      module: ImportModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ImportController],
    };
  }
}
