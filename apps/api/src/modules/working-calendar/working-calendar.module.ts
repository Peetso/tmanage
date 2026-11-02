import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  WORKING_CALENDAR_SERVICE,
  WorkingCalendarController,
} from './working-calendar.controller.js';
import { WorkingCalendarRepository } from './working-calendar.repository.js';
import { WorkingCalendarService } from './working-calendar.service.js';

/** 53-02 wiring: the working calendar routes over the tenant database and the audit service. */
@Module({})
export class WorkingCalendarModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: WORKING_CALENDAR_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new WorkingCalendarService({
          database,
          audit,
          repository: new WorkingCalendarRepository(),
        }),
    };
    return {
      module: WorkingCalendarModule,
      providers: [service],
      controllers: [WorkingCalendarController],
    };
  }
}
