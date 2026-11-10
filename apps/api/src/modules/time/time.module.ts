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
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import {
  TIME_AUTO_SERVICE,
  TIME_TEAM_SERVICE,
  TimeAutoController,
  TimeTeamController,
} from './time-auto.controller.js';
import { AutoTimeFiler } from './time-auto-filing.js';
import { TimeAutoRepository } from './time-auto.repository.js';
import { TimeAutoService } from './time-auto.service.js';
import { TimeTeamService } from './time-team.service.js';
import { TIME_SERVICE, TimeController } from './time.controller.js';
import { TimeRepository } from './time.repository.js';
import { TimeService } from './time.service.js';
import { TIMESHEETS_SERVICE, TimesheetsController } from './timesheets.controller.js';
import { TimesheetsRepository } from './timesheets.repository.js';
import { TimesheetsService } from './timesheets.service.js';

/**
 * 52-01 wiring. The work-items repository is injected when the work module exports it and built
 * here otherwise (it holds no state); the 56-05 limiter is optional, so a composition without the
 * rate-limits module still runs (heartbeats then go unthrottled). 52-03 period locks ride along
 * (`locks.*`): their repositories hold no state and are built here. 52-02 timesheets
 * (`timesheets.*`) write new entries through the work module's time-log repository (rate snapshots).
 */
/** FIX-2026-11-10: the one automatic-session filer the timer, Team time and timesheets share. */
const AUTO_TIME_FILER = Symbol('AUTO_TIME_FILER');

@Module({})
export class TimeModule {
  static register(): DynamicModule {
    const filer: Provider = {
      provide: AUTO_TIME_FILER,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, { token: WORK_ITEMS_REPOSITORY, optional: true }],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        workItems: WorkItemsRepository | null | undefined,
      ) =>
        new AutoTimeFiler({
          database,
          audit,
          repository: new TimeAutoRepository(),
          timers: new TimeRepository(),
          sheets: new TimesheetsRepository(),
          settings: new OrgSettingsRepository(),
          timeLogs: new WorkTimeLogsRepository(),
          workItems: workItems ?? new WorkItemsRepository(),
        }),
    };
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
    const sheets: Provider = {
      provide: TIMESHEETS_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        AUTO_TIME_FILER,
        { token: WORK_ITEMS_REPOSITORY, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        autoFiler: AutoTimeFiler,
        workItems: WorkItemsRepository | null | undefined,
      ) =>
        new TimesheetsService({
          database,
          audit,
          autoFiler,
          repository: new TimesheetsRepository(),
          timeLogs: new WorkTimeLogsRepository(),
          workItems: workItems ?? new WorkItemsRepository(),
          holders: new TimeLocksRepository(),
          notifications: new NotificationsRepository(),
        }),
    };
    // FIX-2026-11-10: automatic tracking (own) and the team time view.
    const auto: Provider = {
      provide: TIME_AUTO_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        AUTO_TIME_FILER,
        { token: WORK_ITEMS_REPOSITORY, optional: true },
        { token: DURABLE_RATE_LIMITER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        autoFiler: AutoTimeFiler,
        workItems: WorkItemsRepository | null | undefined,
        limiter: DurableRateLimiter | null | undefined,
      ) =>
        new TimeAutoService({
          database,
          audit,
          filer: autoFiler,
          repository: new TimeAutoRepository(),
          timers: new TimeRepository(),
          settings: new OrgSettingsRepository(),
          workItems: workItems ?? new WorkItemsRepository(),
          // Absent: the service keeps an in-process window instead (review L4).
          limiter: limiter ?? null,
        }),
    };
    const team: Provider = {
      provide: TIME_TEAM_SERVICE,
      inject: [TENANT_DATABASE, AUTO_TIME_FILER],
      useFactory: (database: TenantDatabase, autoFiler: AutoTimeFiler) =>
        new TimeTeamService({
          database,
          filer: autoFiler,
          auto: new TimeAutoRepository(),
          sheets: new TimesheetsRepository(),
          timers: new TimeRepository(),
          settings: new OrgSettingsRepository(),
        }),
    };
    return {
      module: TimeModule,
      providers: [filer, service, locks, sheets, auto, team],
      controllers: [
        TimeController,
        TimeLocksController,
        TimesheetsController,
        TimeAutoController,
        TimeTeamController,
      ],
    };
  }
}
