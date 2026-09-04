import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  FILES_SERVICE,
  FILE_ASSETS_REPOSITORY,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
  UPLOAD_SESSIONS_REPOSITORY,
  UPLOAD_SESSION_SWEEPER,
  USAGE_COUNTERS_REPOSITORY,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { FileAssetsRepository } from './file-assets.repository.js';
import { UploadSessionsRepository } from './upload-sessions.repository.js';
import { UsageCountersRepository } from './usage-counters.repository.js';
import { FilesService } from './files.service.js';
import { UploadSessionSweeper } from './upload-session-sweeper.js';
import { UploadSessionsController } from './upload-sessions.controller.js';
import { PortalUploadSessionsController } from './portal-upload-sessions.controller.js';
import { UploadPartsController } from './upload-parts.controller.js';

/**
 * FILE-001's wiring.
 *
 * `ProjectsRepository` and `ClientRequestsRepository` are constructed here rather than
 * injected, for `RequestsModule`'s documented reason: both owning modules are registered
 * through `.register()`, and importing one would build a second copy of the dynamic module.
 * A repository is a stateless collection of queries, so this module owning its own
 * read-only handles on `projects` and `client_requests` costs nothing and reads honestly.
 *
 * `FilesService` takes ten constructor arguments. Counted against the other modules' copies
 * on purpose: the object store is the ninth and the outbox the tenth, and a copy built
 * elsewhere without the outbox would reserve bytes nobody is ever told about — the wiring
 * defect the inbox session found in `PortalInboxService`.
 *
 * `UploadPartsController` (FILE-001b) is the third door: public, tenantless, the local
 * stand-in for the bucket. It injects `LOCAL_PART_SINK` optionally and nothing from this
 * module — the bytes never pass through `FilesService`, exactly as they would not pass
 * through it on the way to R2.
 */
@Module({})
export class FilesModule {
  static register(): DynamicModule {
    const repositories: Provider[] = [
      { provide: UPLOAD_SESSIONS_REPOSITORY, useFactory: () => new UploadSessionsRepository() },
      { provide: FILE_ASSETS_REPOSITORY, useFactory: () => new FileAssetsRepository() },
      { provide: USAGE_COUNTERS_REPOSITORY, useFactory: () => new UsageCountersRepository() },
    ];

    const service: Provider = {
      provide: FILES_SERVICE,
      inject: [
        TENANT_DATABASE,
        UPLOAD_SESSIONS_REPOSITORY,
        FILE_ASSETS_REPOSITORY,
        USAGE_COUNTERS_REPOSITORY,
        OBJECT_STORE,
        API_CONFIG,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        sessions: UploadSessionsRepository,
        assets: FileAssetsRepository,
        counters: UsageCountersRepository,
        store: ObjectStore,
        config: ApiConfig,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) =>
        new FilesService(
          database,
          sessions,
          assets,
          counters,
          new ProjectsRepository(),
          new ClientRequestsRepository(),
          store,
          config,
          audit,
          outbox,
        ),
    };

    // USAGE-001. The sweeper is a job, not a route: exported so `sweep.ts` can resolve it
    // from the application context, and constructed on the same service instance the
    // controllers use, so its release is the one `cancel` makes.
    const sweeper: Provider = {
      provide: UPLOAD_SESSION_SWEEPER,
      inject: [TENANT_DATABASE, UPLOAD_SESSIONS_REPOSITORY, FILES_SERVICE],
      useFactory: (
        database: TenantDatabase,
        sessions: UploadSessionsRepository,
        files: FilesService,
      ) => new UploadSessionSweeper(database, sessions, files),
    };

    return {
      module: FilesModule,
      providers: [...repositories, service, sweeper],
      exports: [service, sweeper],
      controllers: [
        UploadSessionsController,
        PortalUploadSessionsController,
        UploadPartsController,
      ],
    };
  }
}
