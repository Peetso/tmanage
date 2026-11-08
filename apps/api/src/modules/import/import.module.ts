import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  IMPORT_JOBS_REPOSITORY,
  IMPORT_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { ConnectorsRepository } from '../connectors/connectors.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkCommentsRepository } from '../work/work-comments.repository.js';
import { PM_FETCHER } from './pm-egress.js';
import type { PmFetch } from './pm-egress.js';
import { PmImportController } from './pm-import.controller.js';
import { PmImportRepository } from './pm-import.repository.js';
import { PM_IMPORT_SERVICE, PmImportService } from './pm-import.service.js';
import { ImportJobsRepository } from './import-jobs.repository.js';
import { ImportRowsRepository } from './import-rows.repository.js';
import { ImportService } from './import.service.js';
import { ImportController } from './import.controller.js';
import { JIRA_FETCHER } from './jira-rest.js';
import type { JiraFetch } from './jira-rest.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkspacesRepository } from '../tenancy/workspaces.repository.js';

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
        new ImportService(
          database,
          jobs,
          new ImportRowsRepository(),
          new ProjectsRepository(),
          new WorkspacesRepository(),
        ),
    };
    // R22-e: the Jira REST source's fetcher — global `fetch` (Node 20), no new dependency.
    const jiraFetcher: Provider = {
      provide: JIRA_FETCHER,
      useValue: ((url, init) => fetch(url, init)) satisfies JiraFetch,
    };

    // R45 L3 (54-25): the Trello / Asana token import. Global `fetch` behind the egress guard;
    // the job runs after the response on the event loop (`setImmediate`), never awaited by it.
    const pmFetcher: Provider = {
      provide: PM_FETCHER,
      useValue: ((url, init) => fetch(url, init)) satisfies PmFetch,
    };
    const pmService: Provider = {
      provide: PM_IMPORT_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, PM_FETCHER],
      useFactory: (database: TenantDatabase, config: ApiConfig, pmFetch: PmFetch) =>
        new PmImportService(database, {
          fetch: pmFetch,
          cipher: createSeedCipher(config.mfaSeedKeys),
          vault: new ConnectorsRepository(),
          pm: new PmImportRepository(),
          projects: new ProjectsRepository(),
          jobs: new ImportJobsRepository(),
          rows: new ImportRowsRepository(),
          workItems: new WorkItemsRepository(),
          comments: new WorkCommentsRepository(),
          now: () => new Date(),
          schedule: (task) => {
            setImmediate(() => {
              task().catch(() => undefined);
            });
          },
        }),
    };

    return {
      module: ImportModule,
      providers: [repository, service, jiraFetcher, pmFetcher, pmService],
      exports: [service],
      controllers: [ImportController, PmImportController],
    };
  }
}
