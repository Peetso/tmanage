import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  BULK_TRANSITION_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
  WORK_CHECKLIST_SERVICE,
  WORK_COMMENTS_SERVICE,
  WORK_FORMS_REPOSITORY,
  WORK_ITEMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
  WORK_ITEM_LINKS_SERVICE,
  WORK_ITEM_FILES_SERVICE,
  WORK_TIME_LOGS_SERVICE,
  WORK_ITEM_ESTIMATE_SERVICE,
  WORK_WATCHERS_SERVICE,
  WORK_LABELS_SERVICE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemsService } from './work-items.service.js';
import { WorkItemsController } from './work-items.controller.js';
import { WorkChecklistRepository } from './work-checklist.repository.js';
import { WorkChecklistService } from './work-checklist.service.js';
import { WorkChecklistController } from './work-checklist.controller.js';
import { WorkFormsRepository } from './work-forms.repository.js';
import { WorkFormsController } from './work-forms.controller.js';
import { WorkCommentsRepository } from './work-comments.repository.js';
import { WorkCommentsService } from './work-comments.service.js';
import { WorkCommentsController } from './work-comments.controller.js';
import { WorkItemLinksRepository } from './item-links.repository.js';
import { WorkItemLinksService } from './item-links.service.js';
import { WorkItemLinksController } from './item-links.controller.js';
import { WorkItemFilesRepository } from './item-files.repository.js';
import { WorkItemFilesService } from './item-files.service.js';
import { WorkItemFilesController } from './item-files.controller.js';
import { BulkTransitionService } from './bulk-transition.service.js';
import { BulkTransitionController } from './bulk-transition.controller.js';
import { WorkTimeLogsRepository } from './time-logs.repository.js';
import { WorkTimeLogsService } from './time-logs.service.js';
import { WorkTimeLogsController } from './time-logs.controller.js';
import { WorkItemEstimateRepository } from './item-estimate.repository.js';
import { WorkItemEstimateService } from './item-estimate.service.js';
import { WorkItemEstimateController } from './item-estimate.controller.js';
import { WorkWatchersRepository } from './watchers.repository.js';
import { WorkWatchersService } from './watchers.service.js';
import { WorkWatchersController } from './watchers.controller.js';
import { WorkLabelsRepository } from './work-labels.repository.js';
import { WorkLabelsService } from './work-labels.service.js';
import { WorkLabelsController } from './work-labels.controller.js';

/**
 * WORK-001's wiring.
 *
 * The audit service is injected rather than optional here, unlike in the constructor's own
 * signature: the running application always has one, and the optionality exists so a test can
 * construct the service without wiring an audit path and then assert that nothing was written.
 */
@Module({})
export class WorkModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: WORK_ITEMS_REPOSITORY,
      useFactory: () => new WorkItemsRepository(),
    };

    const service: Provider = {
      provide: WORK_ITEMS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        workItems: WorkItemsRepository,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) => new WorkItemsService(database, workItems, audit, new ProjectsRepository(), outbox),
    };

    const checklistService: Provider = {
      provide: WORK_CHECKLIST_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkChecklistService(database, workItems, new WorkChecklistRepository()),
    };

    // WORK intake forms (x146). A stateless repository under its token; the controller injects it
    // alongside the tenant database and the work-items service (create-from-form uses the existing
    // work path — no new create logic here).
    const formsRepository: Provider = {
      provide: WORK_FORMS_REPOSITORY,
      useFactory: () => new WorkFormsRepository(),
    };

    const commentsService: Provider = {
      provide: WORK_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkCommentsService(database, workItems, new WorkCommentsRepository()),
    };

    // x204. Typed links between work items — a sub-resource of the work item, so it reuses the
    // work-items repository to resolve both ends tenant-scoped before it writes.
    const itemLinksService: Provider = {
      provide: WORK_ITEM_LINKS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkItemLinksService(database, workItems, new WorkItemLinksRepository()),
    };

    // x205 work-item file attachments. Injects the work-items repository (the parent) and a
    // stateless `FileAssetsRepository` (the file end) — the cross-module join resolves both ends
    // tenant-scoped before it writes.
    const itemFilesService: Provider = {
      provide: WORK_ITEM_FILES_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkItemFilesService(
          database,
          workItems,
          new FileAssetsRepository(),
          new WorkItemFilesRepository(),
        ),
    };

    // x206: the bulk status transition composes the single-item service — it applies no
    // divergent bulk logic, so it needs nothing but that service to reuse every guard.
    const bulkTransitionService: Provider = {
      provide: BULK_TRANSITION_SERVICE,
      inject: [WORK_ITEMS_SERVICE],
      useFactory: (workItems: WorkItemsService) => new BulkTransitionService(workItems),
    };

    // x231. Logged effort per work item. A tenant-scoped sub-resource behind work.read/work.update,
    // wired like the checklist: the work-items repository resolves the parent, the service holds the
    // policy (resolve-before-authorize, minutes bound, delete-own).
    const timeLogsService: Provider = {
      provide: WORK_TIME_LOGS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkTimeLogsService(database, workItems, new WorkTimeLogsRepository()),
    };

    // x258. An effort estimate per work item — a tenant-scoped sub-resource behind
    // work.read/work.update, wired like the time logs: the work-items repository resolves the parent,
    // the service holds the policy (resolve-before-authorize, minutes bound), and the estimate
    // repository reads x231's time logs read-only for the actual figure.
    const estimateService: Provider = {
      provide: WORK_ITEM_ESTIMATE_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkItemEstimateService(database, workItems, new WorkItemEstimateRepository()),
    };

    const watchersService: Provider = {
      provide: WORK_WATCHERS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkWatchersService(database, workItems, new WorkWatchersRepository()),
    };

    // Work item labels / tags (x233). Definitions are org-scoped; assignments hang off a work item.
    const labelsService: Provider = {
      provide: WORK_LABELS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkLabelsService(database, workItems, new WorkLabelsRepository()),
    };

    return {
      module: WorkModule,
      providers: [
        repository,
        service,
        checklistService,
        formsRepository,
        commentsService,
        itemLinksService,
        itemFilesService,
        bulkTransitionService,
        timeLogsService,
        estimateService,
        watchersService,
        labelsService,
      ],
      exports: [service],
      controllers: [
        WorkItemsController,
        WorkChecklistController,
        WorkFormsController,
        WorkCommentsController,
        WorkItemLinksController,
        WorkItemFilesController,
        BulkTransitionController,
        WorkTimeLogsController,
        WorkItemEstimateController,
        WorkWatchersController,
        WorkLabelsController,
      ],
    };
  }
}
