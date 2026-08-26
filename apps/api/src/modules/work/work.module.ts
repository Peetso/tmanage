import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  TENANT_DATABASE,
  WORK_ITEMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemsService } from './work-items.service.js';
import { WorkItemsController } from './work-items.controller.js';

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
      inject: [TENANT_DATABASE, WORK_ITEMS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, workItems: WorkItemsRepository, audit: AuditService) =>
        new WorkItemsService(database, workItems, audit),
    };

    return {
      module: WorkModule,
      providers: [repository, service],
      exports: [service],
      controllers: [WorkItemsController],
    };
  }
}
