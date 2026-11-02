import {
  authorize,
  defaultWorkingCalendar,
  digitsFor,
  localDateOf,
  matchCandidates,
  parseQuickAdd,
  uniqueCandidate,
} from '@tmanage/domain';
import type {
  NameCandidate,
  Principal,
  QuickAddResult,
  QuickAddToken,
  QuickAddTokenKind,
  WorkingCalendar,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { QuickAddRepository } from './quick-add.repository.js';
import type { QuickAddProjectRow } from './quick-add.repository.js';

/**
 * 55-25 — resolve one quick-add line into a title and chips, for the person typing it.
 *
 * The parse is the domain's (`parseQuickAdd`), fed with today in the company's zone, the company
 * calendar (copied from the schedule cascade: the org calendar with its holidays, else the default
 * Sun–Thu one) and only the names the caller can already see:
 *
 * - **People**: the directory the caller may list (`work.read`); narrowed to a project's members
 *   when `projectId` is given or a `#project` token resolved to exactly one project.
 * - **Projects**: the projects the caller may read (`work.read` per project).
 *
 * A name nobody visible carries is not a token and stays in the title — the response never says
 * whether such a person or project exists. More than one match returns the candidates (≤ 5) and no
 * value; one match returns its id as the value. A read: no audit, no write.
 */

export const QUICK_ADD_MAX_QUERY = 300;
export const QUICK_ADD_MAX_CANDIDATES = 5;

export interface QuickAddChipView {
  readonly kind: QuickAddTokenKind;
  /** A user / project id, ISO date, `p1|p2|p3` or minutes; null when the name is ambiguous. */
  readonly value: string | number | null;
  readonly raw: string;
  /** What the chip shows, numerals in the organization's `digits`; null when ambiguous. */
  readonly label: string | null;
  readonly candidates: readonly NameCandidate[];
}

export interface QuickAddResolveView {
  readonly title: string;
  readonly today: string;
  readonly chips: readonly QuickAddChipView[];
}

interface Snapshot {
  readonly calendar: WorkingCalendar;
  readonly digits: 'latn' | 'arab';
  readonly people: readonly NameCandidate[];
  readonly projects: readonly NameCandidate[];
}

function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export class QuickAddService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: QuickAddRepository = new QuickAddRepository(),
    private readonly calendars: WorkingCalendarRepository = new WorkingCalendarRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(
    context: TenantContext,
    principal: Principal,
    q: string,
    projectId: string | null,
  ): Promise<QuickAddResolveView> {
    if (q.length > QUICK_ADD_MAX_QUERY) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'q', message: `must be ${QUICK_ADD_MAX_QUERY} characters or fewer` },
      ]);
    }
    const snapshot = await this.database.read(context, async (runner) => {
      const calendar = await this.calendarOf(runner, context);
      const digits = await this.repository.digits(runner, context);
      const projects = (await this.repository.listProjects(runner, context))
        .filter((row) => this.mayRead(principal, row))
        .map((row) => ({ id: row.id, label: row.name }));
      if (projectId !== null && !projects.some((project) => project.id === projectId)) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      const people = await this.people(runner, context, projectId);
      return { calendar, digits, people, projects } satisfies Snapshot;
    });
    const today = localDateOf(this.now(), snapshot.calendar.timeZone);
    const parse = (people: readonly NameCandidate[]): QuickAddResult =>
      parseQuickAdd(q, {
        today,
        calendar: snapshot.calendar,
        people: people.map((person) => person.label),
        projects: snapshot.projects.map((project) => project.label),
      });

    let people = snapshot.people;
    let result = parse(people);
    if (projectId === null) {
      // A `#project` that names exactly one readable project narrows the owners to its members.
      const projectToken = result.tokens.find((token) => token.kind === 'project');
      const project = projectToken ? this.unique(projectToken, snapshot.projects) : null;
      if (project !== null) {
        people = await this.database.read(context, (runner) =>
          this.people(runner, context, project.id),
        );
        result = parse(people);
      }
    }

    const chips = result.tokens.map((token) => this.chip(token, snapshot, people));
    return { title: result.title, today, chips };
  }

  private chip(
    token: QuickAddToken,
    snapshot: Snapshot,
    people: readonly NameCandidate[],
  ): QuickAddChipView {
    const label = (text: string): string => digitsFor(text, snapshot.digits);
    switch (token.kind) {
      case 'owner':
      case 'project': {
        const pool = token.kind === 'owner' ? people : snapshot.projects;
        const candidates = matchCandidates(token.value, pool, QUICK_ADD_MAX_CANDIDATES);
        const one = uniqueCandidate(token.value, candidates);
        return {
          kind: token.kind,
          value: one?.id ?? null,
          raw: token.raw,
          label: one ? label(one.label) : null,
          candidates,
        };
      }
      case 'date':
        return {
          kind: 'date',
          value: token.value,
          raw: token.raw,
          label: label(token.value),
          candidates: [],
        };
      case 'priority':
        return {
          kind: 'priority',
          value: token.value,
          raw: token.raw,
          label: label(token.value.toUpperCase()),
          candidates: [],
        };
      case 'estimate':
        return {
          kind: 'estimate',
          value: token.value,
          raw: token.raw,
          label: label(minutesLabel(token.value)),
          candidates: [],
        };
    }
  }

  private unique(token: QuickAddToken, pool: readonly NameCandidate[]): NameCandidate | null {
    const value = String(token.value);
    return uniqueCandidate(value, matchCandidates(value, pool, QUICK_ADD_MAX_CANDIDATES));
  }

  private async people(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
  ): Promise<readonly NameCandidate[]> {
    const rows = await this.repository.listPeople(runner, context, projectId);
    return rows.map((row) => ({ id: row.userId, label: row.displayName }));
  }

  private mayRead(principal: Principal, row: QuickAddProjectRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.id,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /** The org calendar with its holidays, else the default calendar in the org's zone. */
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
