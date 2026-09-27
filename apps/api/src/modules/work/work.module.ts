import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
  WORK_CHECKLIST_SERVICE,
  WORK_COMMENTS_SERVICE,
  WORK_FORMS_REPOSITORY,
  WORK_ITEMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
  WORK_WATCHERS_SERVICE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
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
import { WorkWatchersRepository } from './watchers.repository.js';
import { WorkWatchersService } from './watchers.service.js';
import { WorkWatchersController } from './watchers.controller.js';

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

    const watchersService: Provider = {
      provide: WORK_WATCHERS_SERVICE,
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository) =>
        new WorkWatchersService(database, workItems, new WorkWatchersRepository()),
    };

    return {
      module: WorkModule,
      providers: [
        repository,
        service,
        checklistService,
        formsRepository,
        commentsService,
        watchersService,
      ],
      exports: [service],
      controllers: [
        WorkItemsController,
        WorkChecklistController,
        WorkFormsController,
        WorkCommentsController,
        WorkWatchersController,
      ],
    };
  }
}
