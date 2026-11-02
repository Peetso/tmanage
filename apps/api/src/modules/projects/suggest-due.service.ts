import {
  WorkingCalendarRangeError,
  authorize,
  defaultWorkingCalendar,
  localDateOf,
  medianLeadWorkingDays,
  suggestDueDate,
  workingDaysBetween,
} from '@tmanage/domain';
import type { DueDateSuggestion, Principal, WorkingCalendar } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import { readDatedItems } from './suggest-due.repository.js';

/**
 * 55-07 (R18-d) — suggest a due date for a new item in a project: the median lead (working days
 * between `created_at` and `due_at`) over the project's last 50 dated
 * items, clamped to 1..10 working days, counted from today on the org's working calendar. With no
 * dated items yet the suggestion is the next working day.
 *
 * Authorization: the route asks `work.read`; this service resolves the project inside the tenant
 * and asks `work.read` **of that project** (a non-member reads 404, never a hint the project
 * exists). The answer reveals only a date and a reason — no item, title or count leaves.
 */
export class SuggestDueService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly calendars: WorkingCalendarRepository = new WorkingCalendarRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly readItems: typeof readDatedItems = readDatedItems,
  ) {}

  async suggest(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<DueDateSuggestion> {
    return this.database.read(context, async (runner) => {
      const project = await this.projects.findById(runner, context, projectId);
      if (!project) throw projectNotVisible();
      const permitted = authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: context.organizationId,
          projectId,
          audience: 'internal',
          lifecycle: project.archivedAt ? 'archived' : 'active',
        },
      }).allowed;
      if (!permitted) throw projectNotVisible();

      const calendar = await this.calendarOf(runner, context);
      const samples = await this.leadSamples(runner, context, projectId, calendar);
      try {
        return suggestDueDate({
          today: localDateOf(this.now(), calendar.timeZone),
          calendar,
          medianLeadWorkingDays: medianLeadWorkingDays(samples),
        });
      } catch (error) {
        if (error instanceof WorkingCalendarRangeError) {
          throw new ApiError(
            422,
            'validation_failed',
            'The calendar has no working day to suggest',
          );
        }
        throw error;
      }
    });
  }

  /** Working days from created to due over the project's last dated items (≤ 50 rows). */
  private async leadSamples(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    calendar: WorkingCalendar,
  ): Promise<number[]> {
    const rows = await this.readItems(runner, context, projectId);
    const samples: number[] = [];
    for (const row of rows) {
      if (row.dueAt === null) continue;
      try {
        samples.push(
          workingDaysBetween(
            localDateOf(row.createdAt, calendar.timeZone),
            localDateOf(row.dueAt, calendar.timeZone),
            calendar,
          ),
        );
      } catch (error) {
        // A due date beyond the planning horizon says nothing about the pace; skip it.
        if (!(error instanceof WorkingCalendarRangeError)) throw error;
      }
    }
    return samples;
  }

  /** The org calendar with its holidays, else the default calendar in the org's zone (copied from schedule-cascade). */
  private async calendarOf(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<WorkingCalendar> {
    const row = await this.calendars.findCalendar(runner, context, null);
    if (!row) {
      return defaultWorkingCalendar(await this.calendars.organizationTimeZone(runner, context));
    }
    const holidays = await this.calendars.listHolidays(runner, context, row.id);
    return {
      workingDaysMask: Number(row.workingDaysMask),
      dayStart: String(row.dayStart),
      dayEnd: String(row.dayEnd),
      timeZone: row.timeZone,
      holidays: new Set(holidays.map((h) => h.date)),
    };
  }
}

function projectNotVisible(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
}
