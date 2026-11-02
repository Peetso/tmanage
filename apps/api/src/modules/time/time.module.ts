import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE, WORK_ITEMS_REPOSITORY } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DurableRateLimiter } from '../rate-limits/durable-rate-limiter.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { DURABLE_RATE_LIMITER } from '../rate-limits/durable-throttle.guard.js';
import { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { TIME_LOCKS_SERVICE, TimeLocksController } from './locks.controller.js';
import { TimeLocksRepository } from './locks.repository.js';
import { TimeLocksService } from './locks.service.js';
import { TIME_SERVICE, TimeController } from './time.controller.js';
import { TimeRepository } from './time.repository.js';
import { TimeService } from './time.service.js';

/**
 * 52-01 wiring. The work-items repository is injected when the work module exports it and built
 * here otherwise (it holds no state); the 56-05 limiter is optional, so a composition without the
 * rate-limits module still runs (heartbeats then go unthrottled). 52-03 period locks ride along
 * (`locks.*`): their repositories hold no state and are built here.
 */
@Module({})
export class TimeModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: TIME_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        { token: WORK_ITEMS_REPOSITORY, optional: true },
        { token: DURABLE_RATE_LIMITER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        workItems: WorkItemsRepository | null | undefined,
        limiter: DurableRateLimiter | null | undefined,
      ) =>
        new TimeService({
          database,
          audit,
          repository: new TimeRepository(),
          timeLogs: new WorkTimeLogsRepository(),
          workItems: workItems ?? new WorkItemsRepository(),
          limiter: limiter ?? null,
        }),
    };
    const locks: Provider = {
      provide: TIME_LOCKS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new TimeLocksService({
          database,
          audit,
          repository: new TimeLocksRepository(),
          notifications: new NotificationsRepository(),
        }),
    };
    return {
      module: TimeModule,
      providers: [service, locks],
      controllers: [TimeController, TimeLocksController],
    };
  }
}
