import {
  DEFAULT_DAY_END,
  DEFAULT_DAY_START,
  DEFAULT_WORKING_DAYS_MASK,
  MAX_HOLIDAYS_PER_CALENDAR,
  authorize,
  localDateOf,
  weekdaysOfMask,
} from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import type { OrgHolidayRow, OrgWorkingCalendarRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { CalendarValues, WorkingCalendarRepository } from './working-calendar.repository.js';
import {
  invalid,
  parseCalendarInput,
  parseHolidayInput,
  parsePackKey,
} from './working-calendar.validate.js';

/**
 * 53-02 — the working calendar, member side.
 *
 * - **Org calendar** (`GET/PUT …/working-calendar`): read by every internal member, written with
 *   `org.manage` (the route gate). A PUT names the `version` it last read (0 when no row existed);
 *   a stale version is a 409. No row reads as the default: Sun–Thu, 09:00–17:00, the
 *   organization's time zone.
 * - **Holidays** belong to the org calendar (a holiday write creates the row with the default
 *   first). ≤ 400 per calendar; one per date (a second is a 409). Packs are the static
 *   `@tmanage/domain` packs, never fetched; an import skips dates already present and records the
 *   pack key and version on each row and in the audit row.
 * - **Project override** (`…/projects/:projectId/working-calendar`): `work.read` on the project to
 *   read the effective calendar (the override, else the org's), `project.manage` on the project to
 *   write or remove it. The override changes days, hours and zone; holidays stay the org's.
 * - **Client projection**: {@link clientHolidayProjection} — the date and label only, never the
 *   pack, editor, source or override.
 *
 * Audit: `working_calendar.updated` (any change) and `working_calendar.holidays_imported`; ids,
 * masks, keys and counts only.
 */

export interface HolidayView {
  readonly id: string;
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly source: string;
  readonly packKey: string | null;
  readonly packVersion: string | null;
  readonly estimated: boolean;
}

export interface CalendarView {
  readonly scope: 'org' | 'project';
  readonly projectId: string | null;
  /** No stored row: the default (org) or the org calendar (project). */
  readonly isDefault: boolean;
  /** Project read only: true when no override exists and the org calendar applies. */
  readonly inherited: boolean;
  readonly workingDays: readonly number[];
  readonly dayStart: string;
  readonly dayEnd: string;
  readonly timeZone: string;
  /** 0 when no row is stored. */
  readonly version: number;
  readonly holidays: readonly HolidayView[];
}

export interface ClientHolidayView {
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
}

export interface WorkingCalendarServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    WorkingCalendarRepository,
    | 'findCalendar'
    | 'insertCalendar'
    | 'updateCalendar'
    | 'deleteCalendar'
    | 'listHolidays'
    | 'countHolidays'
    | 'insertHolidays'
    | 'deleteHoliday'
    | 'organizationTimeZone'
    | 'projectExists'
  >;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);
const stale = (): ApiError =>
  new ApiError(409, 'conflict', MESSAGES.conflict, [
    { field: 'version', message: 'working_calendar_version_conflict' },
  ]);
const duplicateDate = (): ApiError =>
  new ApiError(409, 'conflict', 'That date is already a holiday.', [
    { field: 'date', message: 'working_calendar_holiday_exists' },
  ]);
const tooMany = (): ApiError =>
  invalid('holidays', `at most ${String(MAX_HOLIDAYS_PER_CALENDAR)} holidays per calendar`);

const ER_DUP_ENTRY = 1062;

function isDuplicateKey(error: unknown): boolean {
  const marks = (c: unknown): boolean =>
    typeof c === 'object' &&
    c !== null &&
    ((c as { errno?: number }).errno === ER_DUP_ENTRY ||
      (c as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

function requireInternal(principal: Principal): void {
  if (principal.kind !== 'internal') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'calendar.internal_only');
  }
}

function hhmm(value: string): string {
  return value.slice(0, 5);
}

function holidayView(row: OrgHolidayRow): HolidayView {
  return {
    id: row.id,
    date: row.date,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    source: row.source,
    packKey: row.packKey,
    packVersion: row.packVersion,
    estimated: row.estimated,
  };
}

/** The only calendar fields a client may ever see: a holiday's date and label. */
export function clientHolidayProjection(view: CalendarView): readonly ClientHolidayView[] {
  return view.holidays.map((h) => ({ date: h.date, labelEn: h.labelEn, labelAr: h.labelAr }));
}

export class WorkingCalendarService {
  private readonly now: () => Date;

  constructor(private readonly options: WorkingCalendarServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async getOrg(context: TenantContext, principal: Principal): Promise<CalendarView> {
    requireInternal(principal);
    return this.options.database.read(context, (r) => this.orgView(r, context));
  }

  async updateOrg(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<CalendarView> {
    requireInternal(principal);
    const input = parseCalendarInput(body);
    return this.options.database.transaction(context, async (tx) => {
      await this.save(tx, context, null, input);
      return this.orgView(tx, context);
    });
  }

  async addHoliday(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<HolidayView> {
    requireInternal(principal);
    const at = this.now();
    const input = parseHolidayInput(body, localDateOf(at, 'UTC'));
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const calendar = await this.ensureOrgCalendar(tx, context, at);
      const existing = await repo.listHolidays(tx, context, calendar.id);
      if (existing.length >= MAX_HOLIDAYS_PER_CALENDAR) throw tooMany();
      if (existing.some((h) => h.date === input.date)) throw duplicateDate();
      let ids: readonly string[];
      try {
        ids = await repo.insertHolidays(
          tx,
          context,
          calendar.id,
          [{ ...input, source: 'custom', packKey: null, packVersion: null, estimated: false }],
          at,
        );
      } catch (error) {
        if (isDuplicateKey(error)) throw duplicateDate();
        throw error;
      }
      await this.audit(tx, context, 'working_calendar.updated', calendar.id, {
        scope: 'org',
        change: 'holiday_added',
      });
      const id = ids[0] ?? '';
      return {
        id,
        date: input.date,
        labelEn: input.labelEn,
        labelAr: input.labelAr,
        source: 'custom',
        packKey: null,
        packVersion: null,
        estimated: false,
      };
    });
  }

  async deleteHoliday(
    context: TenantContext,
    principal: Principal,
    holidayId: string,
  ): Promise<void> {
    requireInternal(principal);
    const repo = this.options.repository;
    await this.options.database.transaction(context, async (tx) => {
      const calendar = await repo.findCalendar(tx, context, null, true);
      if (calendar === null) throw notFound();
      const removed = await repo.deleteHoliday(tx, context, calendar.id, holidayId);
      if (removed === 0) throw notFound();
      await this.audit(tx, context, 'working_calendar.updated', calendar.id, {
        scope: 'org',
        change: 'holiday_removed',
      });
    });
  }

  async importPack(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<CalendarView> {
    requireInternal(principal);
    const pack = parsePackKey(body);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const calendar = await this.ensureOrgCalendar(tx, context, at);
      const existing = await repo.listHolidays(tx, context, calendar.id);
      const taken = new Set(existing.map((h) => h.date));
      const fresh = pack.holidays.filter((h) => !taken.has(h.date));
      if (existing.length + fresh.length > MAX_HOLIDAYS_PER_CALENDAR) throw tooMany();
      await repo.insertHolidays(
        tx,
        context,
        calendar.id,
        fresh.map((h) => ({
          date: h.date,
          labelEn: h.labelEn,
          labelAr: h.labelAr,
          source: 'pack' as const,
          packKey: pack.packKey,
          packVersion: pack.version,
          estimated: h.estimated,
        })),
        at,
      );
      await this.audit(tx, context, 'working_calendar.holidays_imported', calendar.id, {
        packKey: pack.packKey,
        packVersion: pack.version,
        imported: fresh.length,
        skipped: pack.holidays.length - fresh.length,
      });
      return this.orgView(tx, context);
    });
  }

  async getProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<CalendarView> {
    requireInternal(principal);
    this.requireOnProject(principal, context, projectId, 'work.read');
    return this.options.database.read(context, async (r) => {
      if (!(await this.options.repository.projectExists(r, context, projectId))) throw notFound();
      return this.projectView(r, context, projectId);
    });
  }

  async updateProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    body: unknown,
  ): Promise<CalendarView> {
    requireInternal(principal);
    this.requireOnProject(principal, context, projectId, 'project.manage');
    const input = parseCalendarInput(body);
    return this.options.database.transaction(context, async (tx) => {
      if (!(await this.options.repository.projectExists(tx, context, projectId))) throw notFound();
      await this.save(tx, context, projectId, input);
      return this.projectView(tx, context, projectId);
    });
  }

  /** Remove the project's override: the org calendar applies again. */
  async deleteProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<CalendarView> {
    requireInternal(principal);
    this.requireOnProject(principal, context, projectId, 'project.manage');
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      if (!(await repo.projectExists(tx, context, projectId))) throw notFound();
      const row = await repo.findCalendar(tx, context, projectId, true);
      if (row === null) throw notFound();
      await repo.deleteCalendar(tx, context, row.id);
      await this.audit(tx, context, 'working_calendar.updated', row.id, {
        scope: 'project',
        change: 'override_removed',
      });
      return this.projectView(tx, context, projectId);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private requireOnProject(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    capability: Capability,
  ): void {
    const allowed = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    // A project the caller cannot read is the same 404 as one that does not exist.
    if (!allowed) {
      if (capability === 'work.read') throw notFound();
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'calendar.project');
    }
  }

  /** Insert (version 0) or update (version match) one calendar row; audit the change. */
  private async save(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
    input: CalendarValues & { readonly version: number },
  ): Promise<void> {
    const repo = this.options.repository;
    const at = this.now();
    const { version, ...values } = input;
    const existing = await repo.findCalendar(tx, context, projectId, true);
    let id: string;
    let before: number | null = null;
    if (existing === null) {
      if (version !== 0) throw stale();
      try {
        id = (await repo.insertCalendar(tx, context, projectId, values, at)).id;
      } catch (error) {
        if (isDuplicateKey(error)) throw stale();
        throw error;
      }
    } else {
      if (existing.version !== version) throw stale();
      before = existing.workingDaysMask;
      const changed = await repo.updateCalendar(tx, context, existing.id, version, values, at);
      if (changed === 0) throw stale();
      id = existing.id;
    }
    await this.audit(tx, context, 'working_calendar.updated', id, {
      scope: projectId === null ? 'org' : 'project',
      change: existing === null ? 'created' : 'edited',
      workingDaysMask: values.workingDaysMask,
      previousWorkingDaysMask: before,
      version: version + 1,
    });
  }

  private async ensureOrgCalendar(
    tx: TenantQueryRunner,
    context: TenantContext,
    at: Date,
  ): Promise<OrgWorkingCalendarRow> {
    const repo = this.options.repository;
    const existing = await repo.findCalendar(tx, context, null, true);
    if (existing !== null) return existing;
    const timeZone = await repo.organizationTimeZone(tx, context);
    return repo.insertCalendar(
      tx,
      context,
      null,
      {
        workingDaysMask: DEFAULT_WORKING_DAYS_MASK,
        dayStart: DEFAULT_DAY_START,
        dayEnd: DEFAULT_DAY_END,
        timeZone,
      },
      at,
    );
  }

  private async orgView(runner: TenantQueryRunner, context: TenantContext): Promise<CalendarView> {
    const repo = this.options.repository;
    const row = await repo.findCalendar(runner, context, null);
    const holidays = row === null ? [] : await repo.listHolidays(runner, context, row.id);
    if (row === null) {
      return {
        scope: 'org',
        projectId: null,
        isDefault: true,
        inherited: false,
        workingDays: weekdaysOfMask(DEFAULT_WORKING_DAYS_MASK),
        dayStart: DEFAULT_DAY_START,
        dayEnd: DEFAULT_DAY_END,
        timeZone: await repo.organizationTimeZone(runner, context),
        version: 0,
        holidays: [],
      };
    }
    return rowView(row, holidays.map(holidayView), false);
  }

  private async projectView(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<CalendarView> {
    const org = await this.orgView(runner, context);
    const override = await this.options.repository.findCalendar(runner, context, projectId);
    if (override === null) {
      return { ...org, scope: 'project', projectId, inherited: true, version: 0 };
    }
    return rowView(override, org.holidays, false);
  }

  private async audit(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: 'working_calendar.updated' | 'working_calendar.holidays_imported',
    objectId: string,
    metadata: Readonly<Record<string, string | number | null>>,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
    });
  }
}

function rowView(
  row: OrgWorkingCalendarRow,
  holidays: readonly HolidayView[],
  inherited: boolean,
): CalendarView {
  return {
    scope: row.scope === 'project' ? 'project' : 'org',
    projectId: row.projectId,
    isDefault: false,
    inherited,
    workingDays: weekdaysOfMask(row.workingDaysMask),
    dayStart: hhmm(row.dayStart),
    dayEnd: hhmm(row.dayEnd),
    timeZone: row.timeZone,
    version: row.version,
    holidays,
  };
}
