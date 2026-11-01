import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  FILES_SERVICE,
  FILE_ASSETS_REPOSITORY,
  FILE_SCANNER,
  FILE_DOWNLOAD_SERVICE,
  FILE_VERIFIER,
  MALWARE_SCANNER,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  PORTAL_FILE_LIST_SERVICE,
  QUARANTINE_CLEANUP_JOB,
  FILE_TAGS_SERVICE,
  FILE_FOLDERS_SERVICE,
  FILE_COMMENTS_SERVICE,
  TENANT_DATABASE,
  UPLOAD_SESSIONS_REPOSITORY,
  UPLOAD_SESSION_SWEEPER,
  USAGE_COUNTERS_REPOSITORY,
  USAGE_LEDGER_REPOSITORY,
  USAGE_RECONCILER,
  USAGE_SERVICE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { FileAssetsRepository } from './file-assets.repository.js';
import { UploadSessionsRepository } from './upload-sessions.repository.js';
import { UsageCountersRepository } from './usage-counters.repository.js';
import { UsageLedgerRepository } from './usage-ledger.repository.js';
import { UsageThresholdEvaluator } from './usage-thresholds.js';
import { FilesService } from './files.service.js';
import { FileVerifier } from './file-verifier.js';
import { FileScanner } from './file-scanner.js';
import {
  DEFAULT_FILE_SCAN_JOB_OPTIONS,
  FILE_SCAN_JOB,
  FileScanJob,
  fileScanJobEnabled,
} from './file-scan-job.js';
import { FilePreviewsRepository } from './file-previews.repository.js';
import {
  PREVIEW_JOB,
  PreviewJob,
  previewJobEnabled,
  previewJobOptionsFromEnv,
} from './preview-job.js';
import { FileDownloadService } from './file-download.service.js';
import { FileDownloadsController } from './file-downloads.controller.js';
import { FILE_PREVIEW_SERVICE, FilePreviewService } from './file-preview.service.js';
import { FilePreviewsController } from './file-previews.controller.js';
import { PortalFilePreviewsController } from './portal-file-previews.controller.js';
import {
  PortalFileReviewController,
  PortalReviewMentionCandidatesController,
  PortalReviewThreadsController,
} from './portal-review.controller.js';
import { REVIEW_SERVICE, ReviewService } from './review.service.js';
import { FigmaAccess } from '../figma/figma-access.js';
import {
  FigmaFrameReviewController,
  PortalFigmaFrameReviewController,
} from '../figma/figma-review.controller.js';
import {
  FILE_REVIEW_DECISIONS_SERVICE,
  FileReviewDecisionsService,
} from './file-review-decisions.service.js';
import {
  FileReviewDecisionsController,
  PortalFileReviewDecisionsController,
} from './file-review-decisions.controller.js';
import {
  FileReviewController,
  ReviewMentionCandidatesController,
  ReviewThreadsController,
} from './review.controller.js';
import {
  ATTACHMENT_VERSIONS_SERVICE,
  AttachmentVersionsService,
} from './attachment-versions.service.js';
import { AttachmentVersionsController } from './attachment-versions.controller.js';
import { FileTagsRepository } from './file-tags.repository.js';
import { FileTagsService } from './file-tags.service.js';
import { FileTagsController } from './file-tags.controller.js';
import { FileFoldersRepository } from './folders.repository.js';
import { FileFoldersService } from './folders.service.js';
import { FileFoldersController } from './folders.controller.js';
import { FileCommentsRepository } from './comments.repository.js';
import { FileCommentsService } from './comments.service.js';
import { FileCommentsController } from './comments.controller.js';
import { PortalFileDownloadsController } from './portal-file-downloads.controller.js';
import { PortalFileListService } from './portal-file-list.service.js';
import { PortalFileListController } from './portal-file-list.controller.js';
import { UploadSessionSweeper } from './upload-session-sweeper.js';
import { UsageReconciler } from './usage-reconciler.js';
import { QuarantineCleanupJob } from './quarantine-cleanup.js';
import { UsageService } from './usage.service.js';
import { UsageController } from './usage.controller.js';
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
 * `FilesService` takes twelve constructor arguments. Counted against the other modules' copies
 * on purpose: the object store is the tenth, the outbox the eleventh, and the threshold
 * evaluator (USAGE-001 slice 4) the twelfth. A copy built elsewhere without the outbox — or
 * without the usage ledger beside it (slice 2), or without the evaluator that turns a counter
 * move into a `usage.threshold_reached.v1` — would move a counter nobody is ever told about,
 * the wiring defect the inbox session found in `PortalInboxService`.
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
      { provide: USAGE_LEDGER_REPOSITORY, useFactory: () => new UsageLedgerRepository() },
    ];

    const service: Provider = {
      provide: FILES_SERVICE,
      inject: [
        TENANT_DATABASE,
        UPLOAD_SESSIONS_REPOSITORY,
        FILE_ASSETS_REPOSITORY,
        USAGE_COUNTERS_REPOSITORY,
        USAGE_LEDGER_REPOSITORY,
        OBJECT_STORE,
        API_CONFIG,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        FILE_SCAN_JOB,
      ],
      useFactory: (
        database: TenantDatabase,
        sessions: UploadSessionsRepository,
        assets: FileAssetsRepository,
        counters: UsageCountersRepository,
        ledger: UsageLedgerRepository,
        store: ObjectStore,
        config: ApiConfig,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        scanJob: FileScanJob,
      ) =>
        new FilesService(
          database,
          sessions,
          assets,
          counters,
          ledger,
          new ProjectsRepository(),
          new ClientRequestsRepository(),
          store,
          config,
          audit,
          outbox,
          // USAGE-001 slice 4. Built on the same counters, outbox and audit the reserve and
          // commit paths already use, so the band write and its event commit with the move.
          new UsageThresholdEvaluator(counters, outbox, audit),
          scanJob,
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

    // USAGE-001 slice 3. The counter reconciler is a job too: exported so `reconcile.ts` can
    // resolve it, built on the same counters and ledger repositories the routes and the sweeper
    // use, and on the same audit service — its drift correction and the audit row that explains
    // it commit in one transaction, and a copy without the audit would repair a tenant's quota
    // counter with no trace of the repair.
    const reconciler: Provider = {
      provide: USAGE_RECONCILER,
      inject: [
        TENANT_DATABASE,
        USAGE_COUNTERS_REPOSITORY,
        USAGE_LEDGER_REPOSITORY,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        API_CONFIG,
      ],
      useFactory: (
        database: TenantDatabase,
        counters: UsageCountersRepository,
        ledger: UsageLedgerRepository,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        config: ApiConfig,
        // USAGE-001 slice 4. The reconciler re-evaluates the band under the same lock; the
        // evaluator emits `usage.threshold_reached.v1` when a corrected counter has risen.
      ) =>
        new UsageReconciler(
          database,
          counters,
          ledger,
          audit,
          new UsageThresholdEvaluator(counters, outbox, audit),
          config.storageOrgBytesLimit,
        ),
    };

    // FILE-003. The retention-lifecycle job: exported so `cleanup.ts` can resolve it, built on
    // the same FilesService the routes and the sweeper use — its purge deletes through the same
    // object store, moves the same counter and appends to the same outbox and audit a route's
    // write would, so a copy built without the outbox could not exist here.
    const cleanup: Provider = {
      provide: QUARANTINE_CLEANUP_JOB,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY, FILES_SERVICE, API_CONFIG],
      useFactory: (
        database: TenantDatabase,
        assets: FileAssetsRepository,
        files: FilesService,
        config: ApiConfig,
      ) => new QuarantineCleanupJob(database, assets, files, config.fileRetentionRejectedDays),
    };

    // USAGE-001 slice 5. The read behind the billing screen (§8): the same counters repository
    // the write paths use, plus the config that carries the effective quota. A read-only service —
    // no store, no outbox, no audit — because it moves no counter and appends no event.
    const usage: Provider = {
      provide: USAGE_SERVICE,
      inject: [TENANT_DATABASE, USAGE_COUNTERS_REPOSITORY, API_CONFIG],
      useFactory: (
        database: TenantDatabase,
        counters: UsageCountersRepository,
        config: ApiConfig,
      ) => new UsageService(database, counters, config),
    };

    // FILE-002. The verification pass is a job too: exported so `verify.ts` can resolve
    // it, built on the same store the uploads went into and the same audit and outbox
    // the service writes through — a copy without the outbox would reject files nobody is
    // ever told about.
    const verifier: Provider = {
      provide: FILE_VERIFIER,
      inject: [
        TENANT_DATABASE,
        FILE_ASSETS_REPOSITORY,
        UPLOAD_SESSIONS_REPOSITORY,
        OBJECT_STORE,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        assets: FileAssetsRepository,
        sessions: UploadSessionsRepository,
        store: ObjectStore,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) => new FileVerifier(database, assets, sessions, store, audit, outbox),
    };

    // FILE-002 slice B. The scan pass, after the verifier on the same tick: the same store
    // (it promotes into the zone the uploads' driver owns), the scanner the deployment
    // named, and the same audit and outbox — `file.ready.v1` is appended inside its
    // transaction, and a copy without the outbox would make files ready nobody is told of.
    const scanner: Provider = {
      provide: FILE_SCANNER,
      inject: [
        TENANT_DATABASE,
        FILE_ASSETS_REPOSITORY,
        OBJECT_STORE,
        MALWARE_SCANNER,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        assets: FileAssetsRepository,
        store: ObjectStore,
        malwareScanner: MalwareScanner,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) => new FileScanner(database, assets, store, malwareScanner, audit, outbox),
    };

    // CQ-09. The verify-then-scan passes run in this process when it runs background work
    // (`WORKER_INPROCESS=1` on Hostinger): kicked by every committed upload, once after boot,
    // and on an interval. Off in suites and the `verify:once` CLI, which drive the passes.
    // R4 slice 3. The preview job: TManage's own derivatives (thumbnails, safe SVG copies) of
    // ready files, read from the private zone and written to the `derived` one. In this process
    // under the same switch as the scan job; `preview:once` drives one pass from a CLI.
    const previewJob: Provider = {
      provide: PREVIEW_JOB,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY, OBJECT_STORE],
      useFactory: (database: TenantDatabase, assets: FileAssetsRepository, store: ObjectStore) =>
        new PreviewJob(
          database,
          new FilePreviewsRepository(),
          assets,
          store,
          previewJobEnabled(),
          previewJobOptionsFromEnv(),
        ),
    };

    const scanJob: Provider = {
      provide: FILE_SCAN_JOB,
      // R4 slice 3: a pass that made files ready asks the preview job for one of its own.
      inject: [FILE_VERIFIER, FILE_SCANNER, PREVIEW_JOB],
      useFactory: (fileVerifier: FileVerifier, fileScanner: FileScanner, previews: PreviewJob) =>
        new FileScanJob(
          fileVerifier,
          fileScanner,
          fileScanJobEnabled(),
          DEFAULT_FILE_SCAN_JOB_OPTIONS,
          previews,
        ),
    };

    // FILE-002 slice C. The download gate: its own service, so the read path that hands
    // bytes out shares no method with the write path that takes them in.
    const downloads: Provider = {
      provide: FILE_DOWNLOAD_SERVICE,
      // B3: and the scanner — without one the owner's "downloads before a virus scan" policy is
      // always `allow_labeled`; with one, a stored `block` keeps an unscanned file at a 409.
      inject: [
        TENANT_DATABASE,
        FILE_ASSETS_REPOSITORY,
        OBJECT_STORE,
        AUDIT_SERVICE,
        MALWARE_SCANNER,
      ],
      useFactory: (
        database: TenantDatabase,
        assets: FileAssetsRepository,
        store: ObjectStore,
        audit: AuditService,
        malwareScanner: MalwareScanner,
      ) =>
        new FileDownloadService(
          database,
          assets,
          new ProjectsRepository(),
          new ClientRequestsRepository(),
          store,
          audit,
          malwareScanner,
        ),
    };

    // R4 slice 4. The viewer: manifest, derivative bytes and "Try again", all behind the download
    // gate's own decision (`FileDownloadService.resolve`). It reads `file_previews` and the
    // `derived` zone; "Try again" asks the preview job for a pass.
    const filePreviews: Provider = {
      provide: FILE_PREVIEW_SERVICE,
      inject: [
        TENANT_DATABASE,
        FILE_DOWNLOAD_SERVICE,
        FILE_ASSETS_REPOSITORY,
        OBJECT_STORE,
        AUDIT_SERVICE,
        PREVIEW_JOB,
      ],
      useFactory: (
        database: TenantDatabase,
        downloadService: FileDownloadService,
        assets: FileAssetsRepository,
        store: ObjectStore,
        audit: AuditService,
        previewJob: PreviewJob,
      ) =>
        new FilePreviewService(
          database,
          downloadService,
          assets,
          store,
          audit,
          new FilePreviewsRepository(),
          previewJob,
        ),
    };

    // R4 slice 5. Proofing threads and comments, behind the download gate's own decision on the
    // file each thread hangs on; audit and outbox rows commit with the write.
    const review: Provider = {
      provide: REVIEW_SERVICE,
      inject: [TENANT_DATABASE, FILE_DOWNLOAD_SERVICE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        downloadService: FileDownloadService,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) =>
        new ReviewService(
          database,
          downloadService,
          new ProjectsRepository(),
          audit,
          outbox,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          // R4 slice 13: threads on Figma frames ask the Figma module's read decision.
          new FigmaAccess(database),
        ),
    };

    // R4 slice 11. Approve / Request changes on plain files, behind the same download gate.
    const reviewDecisions: Provider = {
      provide: FILE_REVIEW_DECISIONS_SERVICE,
      inject: [TENANT_DATABASE, FILE_DOWNLOAD_SERVICE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        downloadService: FileDownloadService,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) => new FileReviewDecisionsService(database, downloadService, audit, outbox),
    };

    // FILE-003 · WEB-006. The client's file list, over the same download surface: a read-only
    // service on the tenant database and the file-assets repository. No store, no audit — it
    // hands out no bytes; it names the files the download door would serve, which it audits.
    // C4: and the scanner, so an unscanned file is listed the way the download door treats it.
    const portalFileList: Provider = {
      provide: PORTAL_FILE_LIST_SERVICE,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY, MALWARE_SCANNER],
      useFactory: (
        database: TenantDatabase,
        assets: FileAssetsRepository,
        malwareScanner: MalwareScanner,
      ) => new PortalFileListService(database, assets, malwareScanner),
    };

    // x270. File tags: define org tags and assign / list them on file assets. Read-only over the
    // tenant database and the file-assets repository (it moves no bytes, no counter, no outbox); it
    // constructs its own ProjectsRepository handle for the file's lifecycle, the way the download
    // service does, and its own FileTagsRepository — a stateless collection of queries.
    const fileTags: Provider = {
      provide: FILE_TAGS_SERVICE,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY],
      useFactory: (database: TenantDatabase, assets: FileAssetsRepository) =>
        new FileTagsService(database, assets, new ProjectsRepository(), new FileTagsRepository()),
    };

    // x332. File folders: named folders in a project plus a file's membership of one. Read-only over
    // the tenant database and the file-assets repository (it moves no bytes, no counter, no outbox);
    // it constructs its own ProjectsRepository handle for the project's lifecycle, the way the tags
    // service does, and its own FileFoldersRepository — a stateless collection of queries.
    const fileFolders: Provider = {
      provide: FILE_FOLDERS_SERVICE,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY],
      useFactory: (database: TenantDatabase, assets: FileAssetsRepository) =>
        new FileFoldersService(
          database,
          assets,
          new ProjectsRepository(),
          new FileFoldersRepository(),
        ),
    };

    // x333. File comments: comment on a file asset, list oldest-first, delete own. Read-only over the
    // tenant database and the file-assets repository (it moves no bytes, no counter, no outbox); it
    // constructs its own ProjectsRepository handle for the file's lifecycle, the way file tags do,
    // and its own FileCommentsRepository — a stateless collection of queries.
    const fileComments: Provider = {
      provide: FILE_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY],
      useFactory: (database: TenantDatabase, assets: FileAssetsRepository) =>
        new FileCommentsService(
          database,
          assets,
          new ProjectsRepository(),
          new FileCommentsRepository(),
        ),
    };

    // C7 (0228). A plain attachment's version history: reads and appends version rows; serves no
    // bytes (each version downloads through the download gate above, under the scan policy).
    const attachmentVersions: Provider = {
      provide: ATTACHMENT_VERSIONS_SERVICE,
      inject: [TENANT_DATABASE, FILE_ASSETS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, assets: FileAssetsRepository, audit: AuditService) =>
        new AttachmentVersionsService(database, assets, new ProjectsRepository(), audit),
    };

    return {
      module: FilesModule,
      providers: [
        ...repositories,
        service,
        fileTags,
        fileFolders,
        fileComments,
        usage,
        sweeper,
        reconciler,
        cleanup,
        verifier,
        scanner,
        previewJob,
        scanJob,
        downloads,
        filePreviews,
        review,
        reviewDecisions,
        portalFileList,
        attachmentVersions,
      ],
      exports: [
        service,
        fileTags,
        fileFolders,
        fileComments,
        usage,
        sweeper,
        reconciler,
        cleanup,
        verifier,
        scanner,
        previewJob,
        scanJob,
        downloads,
        filePreviews,
        review,
        portalFileList,
        attachmentVersions,
      ],
      controllers: [
        UploadSessionsController,
        PortalUploadSessionsController,
        UploadPartsController,
        FileDownloadsController,
        PortalFileDownloadsController,
        FilePreviewsController,
        PortalFilePreviewsController,
        FileReviewController,
        ReviewThreadsController,
        ReviewMentionCandidatesController,
        // R4 slice 8 — the client's thread routes under /portal.
        PortalFileReviewController,
        PortalReviewThreadsController,
        PortalReviewMentionCandidatesController,
        // R4 slice 11 — decisions on plain files (studio and portal).
        FileReviewDecisionsController,
        PortalFileReviewDecisionsController,
        // R4 slice 13 — threads on Figma frames (studio and portal).
        FigmaFrameReviewController,
        PortalFigmaFrameReviewController,
        PortalFileListController,
        UsageController,
        FileTagsController,
        FileFoldersController,
        FileCommentsController,
        AttachmentVersionsController,
      ],
    };
  }
}
