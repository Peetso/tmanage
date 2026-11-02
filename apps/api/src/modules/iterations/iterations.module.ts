import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { defaultWorkingCalendar } from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { ITERATIONS_SERVICE, IterationsController } from './iterations.controller.js';
import { IterationsRepository } from './iterations.repository.js';
import { IterationsService } from './iterations.service.js';
import type { IterationCalendarSource } from './iterations.service.js';

/**
 * The effective calendar of a project: its 53-02 override (with the org's holidays), else the org
 * calendar, else the default Sun–Thu calendar in the organization's zone.
 */
export class ProjectCalendarSource implements IterationCalendarSource {
  constructor(private readonly calendars = new WorkingCalendarRepository()) {}

  async calendarFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<WorkingCalendar> {
    const org = await this.calendars.findCalendar(runner, context, null);
    const override = await this.calendars.findCalendar(runner, context, projectId);
    const row = override ?? org;
    const holidays =
      org === null
        ? []
        : (await this.calendars.listHolidays(runner, context, org.id)).map((h) => h.date);
    if (row === null) {
      return defaultWorkingCalendar(
        await this.calendars.organizationTimeZone(runner, context),
        holidays,
      );
    }
    return {
      workingDaysMask: Number(row.workingDaysMask),
      dayStart: String(row.dayStart),
      dayEnd: String(row.dayEnd),
      timeZone: row.timeZone,
      holidays: new Set(holidays),
    };
  }
}

/** 53-21 wiring: the iteration routes over the tenant database, the audit service and the calendar. */
@Module({})
export class IterationsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: ITERATIONS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new IterationsService({
          database,
          audit,
          repository: new IterationsRepository(),
          calendars: new ProjectCalendarSource(),
        }),
    };
    return {
      module: IterationsModule,
      providers: [service],
      controllers: [IterationsController],
    };
  }
}
