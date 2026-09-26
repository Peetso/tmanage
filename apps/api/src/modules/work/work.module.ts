import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
  WORK_CHECKLIST_SERVICE,
  WORK_ITEMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
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

    return {
      module: WorkModule,
      providers: [repository, service, checklistService],
      exports: [service],
      controllers: [WorkItemsController, WorkChecklistController],
    };
  }
}
