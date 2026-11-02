import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  orgHolidays,
  orgWorkingCalendars,
  organizations,
  projects,
} from '../../common/database/schema.js';
import type {
  HolidaySource,
  OrgHolidayRow,
  OrgWorkingCalendarRow,
  WorkingCalendarScope,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 53-02 — storage for `org_working_calendars` and `org_holidays` (0283). Every statement carries
 * the `organization_id` from the caller's context; no input names an organization.
 */

export interface CalendarValues {
  readonly workingDaysMask: number;
  /** `HH:MM`; stored as TIME. */
  readonly dayStart: string;
  readonly dayEnd: string;
  readonly timeZone: string;
}

export interface NewHoliday {
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly source: HolidaySource;
  readonly packKey: string | null;
  readonly packVersion: string | null;
  readonly estimated: boolean;
}

export class WorkingCalendarRepository {
  /** The org calendar (`projectId` null) or a project's override; locked when asked. */
  async findCalendar(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
    lock = false,
  ): Promise<OrgWorkingCalendarRow | null> {
    const scope: WorkingCalendarScope = projectId === null ? 'org' : 'project';
    const query = tenantDrizzle(runner)
      .select()
      .from(orgWorkingCalendars)
      .where(
        and(
          eq(orgWorkingCalendars.organizationId, context.organizationId),
          eq(orgWorkingCalendars.scope, scope),
          projectId === null
            ? isNull(orgWorkingCalendars.projectId)
            : eq(orgWorkingCalendars.projectId, projectId),
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insertCalendar(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
    values: CalendarValues,
    at: Date,
  ): Promise<OrgWorkingCalendarRow> {
    await tenantDrizzle(runner)
      .insert(orgWorkingCalendars)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        scope: projectId === null ? 'org' : 'project',
        projectId,
        ...values,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
    const row = await this.findCalendar(runner, context, projectId);
    if (!row) throw new Error('working calendar vanished immediately after insert');
    return row;
  }

  /** Update when the stored version still is `version`; the count tells the caller it lost. */
  async updateCalendar(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    version: number,
    values: CalendarValues,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(orgWorkingCalendars)
      .set({ ...values, version: version + 1, updatedAt: at })
      .where(
        and(
          eq(orgWorkingCalendars.organizationId, context.organizationId),
          eq(orgWorkingCalendars.id, id),
          eq(orgWorkingCalendars.version, version),
        ),
      );
    return result[0].affectedRows;
  }

  async deleteCalendar(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(orgWorkingCalendars)
      .where(
        and(
          eq(orgWorkingCalendars.organizationId, context.organizationId),
          eq(orgWorkingCalendars.id, id),
        ),
      );
    return result[0].affectedRows;
  }

  async listHolidays(
    runner: TenantQueryRunner,
    context: TenantContext,
    calendarId: string,
  ): Promise<readonly OrgHolidayRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgHolidays)
      .where(
        and(
          eq(orgHolidays.organizationId, context.organizationId),
          eq(orgHolidays.calendarId, calendarId),
        ),
      )
      .orderBy(asc(orgHolidays.date))
      .limit(500);
  }

  async countHolidays(
    runner: TenantQueryRunner,
    context: TenantContext,
    calendarId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(orgHolidays)
      .where(
        and(
          eq(orgHolidays.organizationId, context.organizationId),
          eq(orgHolidays.calendarId, calendarId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  async insertHolidays(
    runner: TenantQueryRunner,
    context: TenantContext,
    calendarId: string,
    holidays: readonly NewHoliday[],
    at: Date,
  ): Promise<readonly string[]> {
    if (holidays.length === 0) return [];
    const rows = holidays.map((holiday) => ({
      id: uuidv7(),
      organizationId: context.organizationId,
      calendarId,
      ...holiday,
      createdAt: at,
    }));
    await tenantDrizzle(runner).insert(orgHolidays).values(rows);
    return rows.map((row) => row.id);
  }

  async deleteHoliday(
    runner: TenantQueryRunner,
    context: TenantContext,
    calendarId: string,
    holidayId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(orgHolidays)
      .where(
        and(
          eq(orgHolidays.organizationId, context.organizationId),
          eq(orgHolidays.calendarId, calendarId),
          eq(orgHolidays.id, holidayId),
        ),
      );
    return result[0].affectedRows;
  }

  async organizationTimeZone(runner: TenantQueryRunner, context: TenantContext): Promise<string> {
    const rows = await tenantDrizzle(runner)
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0]?.timezone ?? 'UTC';
  }

  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }
}
