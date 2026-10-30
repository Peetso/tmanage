import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  BULK_TRANSITION_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
  WORK_CHECKLIST_SERVICE,
  WORK_SUBTASKS_SERVICE,
  WORK_COMMENTS_SERVICE,
  WORK_FORMS_REPOSITORY,
  WORK_ITEMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
  WORK_ITEM_LINKS_SERVICE,
  WORK_ITEM_FILES_SERVICE,
  WORK_ITEM_REMINDERS_SERVICE,
  WORK_RELATIONS_GRAPH_SERVICE,
  WORK_TIME_LOGS_SERVICE,
  WORK_ITEM_ESTIMATE_SERVICE,
  WORK_WATCHERS_SERVICE,
  WORK_LABELS_SERVICE,
  WORK_CUSTOM_FIELDS_SERVICE,
  WORK_ITEM_RECURRENCE_SERVICE,
  WORK_ACTIVITY_LOG_SERVICE,
  WORK_BOARD_COLUMNS_SERVICE,
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
import { WorkSubtasksRepository } from './subtasks.repository.js';
import { WorkSubtasksService } from './subtasks.service.js';
import { WorkSubtasksController } from './subtasks.controller.js';
import { WorkFormsRepository } from './work-forms.repository.js';
import { WorkFormsController } from './work-forms.controller.js';
import { WorkCommentsRepository } from './work-comments.repository.js';
import { WorkCommentsService } from './work-comments.service.js';
import { WorkCommentsController } from './work-comments.controller.js';
import { WorkItemLinksRepository } from './item-links.repository.js';
import { WorkItemLinksService } from './item-links.service.js';
import { WorkItemLinksController } from './item-links.controller.js';
import { WorkRelationsGraphRepository } from './relations-graph.repository.js';
import { WorkRelationsGraphService } from './relations-graph.service.js';
import { WorkRelationsGraphController } from './relations-graph.controller.js';
import { WorkItemFilesRepository } from './item-files.repository.js';
import { WorkItemFilesService } from './item-files.service.js';
import { WorkItemFilesController } from './item-files.controller.js';
import { WorkItemRemindersRepository } from './item-reminders.repository.js';
import { WorkItemRemindersService } from './item-reminders.service.js';
import { WorkItemRemindersController } from './item-reminders.controller.js';
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
import { WorkItemRecurrenceRepository } from './item-recurrence.repository.js';
import { WorkItemRecurrenceService } from './item-recurrence.service.js';
import { WorkItemRecurrenceController } from './item-recurrence.controller.js';
import { WorkActivityLogService } from './activity-log.service.js';
import { WorkActivityLogController } from './activity-log.controller.js';
import { WorkChecklistTemplatesRepository } from './checklist-templates.repository.js';
import { WorkChecklistTemplatesService } from './checklist-templates.service.js';
import {
  WorkChecklistTemplatesController,
  WORK_CHECKLIST_TEMPLATES_SERVICE,
} from './checklist-templates.controller.js';
import { WorkCustomFieldsRepository } from './custom-fields.repository.js';
import { WorkCustomFieldsService } from './custom-fields.service.js';
import { WorkCustomFieldsController } from './custom-fields.controller.js';
import { WorkBoardColumnsRepository } from './board-columns.repository.js';
import { WorkBoardColumnsService } from './board-columns.service.js';
import { WorkBoardColumnsController } from './board-columns.controller.js';

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

    // x307. A work item's ordered subtasks / breakdown — a tenant-scoped sub-resource behind
    // work.read/work.update, wired like the checklist: the work-items repository resolves the
    // parent, the service holds the policy (resolve-before-authorize) and the done/total roll-up.
    const subtasksService: Provider = {
      provide: WORK_SUBTASKS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkSubtasksService(database, workItems, new WorkSubtasksRepository()),
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

    // x274. Read-only relations graph over x204's work_item_links — no new table. Injects the
    // work-items repository (root resolution + neighbour readability) and a stateless read repo.
    const relationsGraphService: Provider = {
      provide: WORK_RELATIONS_GRAPH_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkRelationsGraphService(database, workItems, new WorkRelationsGraphRepository()),
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

    // x256. A personal reminder on a work item — a self-service sub-resource behind work.read,
    // wired like the watchers: the work-items repository resolves the parent tenant-scoped, the
    // service holds the policy (resolve-before-authorize, own-only, bound remind_at, upsert/clear).
    const itemRemindersService: Provider = {
      provide: WORK_ITEM_REMINDERS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkItemRemindersService(database, workItems, new WorkItemRemindersRepository()),
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
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository, audit: AuditService) =>
        new WorkTimeLogsService(database, workItems, new WorkTimeLogsRepository(), audit),
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

    // Work item recurrence (x257). A tenant-scoped sub-resource behind work.read/work.update; the
    // work-items repository resolves the parent, the service holds the policy (resolve-before-
    // authorize) and the pure next-occurrence arithmetic. generate-next writes no work item.
    const recurrenceService: Provider = {
      provide: WORK_ITEM_RECURRENCE_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkItemRecurrenceService(database, workItems, new WorkItemRecurrenceRepository()),
    };

    // x291. A work item's merged activity timeline — read-only, no table. Wired like the watchers:
    // the work-items repository resolves the parent tenant-scoped, and the service reads x147's
    // comments and the audit trail read-only and merges them newest-first. No write, no capability.
    const activityLogService: Provider = {
      provide: WORK_ACTIVITY_LOG_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkActivityLogService(database, workItems),
    };

    // x292. Reusable checklist templates. Definitions are org-scoped; applying one seeds rows into
    // the existing checklist table through this slice's own repository, so it stays file-disjoint
    // from the checklist slice while reusing the work-items repository to resolve the parent item.
    const checklistTemplatesService: Provider = {
      provide: WORK_CHECKLIST_TEMPLATES_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkChecklistTemplatesService(
          database,
          workItems,
          new WorkChecklistTemplatesRepository(),
        ),
    };

    // x306. Org-defined custom fields on work items — definitions are org metadata (org.manage),
    // values hang off a work item (work.read/work.update). The work-items repository resolves the
    // parent tenant-scoped; the service holds the policy (org.manage on definitions,
    // resolve-before-authorize on values, type/options validation, idempotent value upsert).
    const customFieldsService: Provider = {
      provide: WORK_CUSTOM_FIELDS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkCustomFieldsService(database, workItems, new WorkCustomFieldsRepository()),
    };

    // x308. An organization's custom work-board columns — an org-level display grouping over the
    // existing work states, so it needs only the tenant database (no work-item parent). The service
    // holds the policy (org.manage on writes, resolve-before-authorize, the state-key allowlist).
    const boardColumnsService: Provider = {
      provide: WORK_BOARD_COLUMNS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new WorkBoardColumnsService(database, new WorkBoardColumnsRepository()),
    };

    return {
      module: WorkModule,
      providers: [
        repository,
        service,
        checklistService,
        subtasksService,
        formsRepository,
        commentsService,
        itemLinksService,
        relationsGraphService,
        itemFilesService,
        itemRemindersService,
        bulkTransitionService,
        timeLogsService,
        estimateService,
        watchersService,
        labelsService,
        recurrenceService,
        activityLogService,
        checklistTemplatesService,
        customFieldsService,
        boardColumnsService,
      ],
      exports: [service],
      controllers: [
        WorkItemsController,
        WorkChecklistController,
        WorkSubtasksController,
        WorkFormsController,
        WorkCommentsController,
        WorkItemLinksController,
        WorkRelationsGraphController,
        WorkItemFilesController,
        WorkItemRemindersController,
        BulkTransitionController,
        WorkTimeLogsController,
        WorkItemEstimateController,
        WorkWatchersController,
        WorkLabelsController,
        WorkItemRecurrenceController,
        WorkActivityLogController,
        WorkChecklistTemplatesController,
        WorkCustomFieldsController,
        WorkBoardColumnsController,
      ],
    };
  }
}
