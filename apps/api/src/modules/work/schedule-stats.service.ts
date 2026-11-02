import { Logger } from '@nestjs/common';
import {
  authorize,
  criticalPath,
  defaultWorkingCalendar,
  DependencyCycleDetected,
  isDependencyKind,
  localDateOf,
  uuidv7,
  WorkingCalendarRangeError,
} from '@tmanage/domain';
import type {
  Audience,
  Capability,
  Principal,
  TypedDependencyEdge,
  WorkingCalendar,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { MAX_GRAPH_NODES } from './work-graph.repository.js';
import { ScheduleStatsRepository } from './schedule-stats.repository.js';
import type { ScheduleStatsItemRow } from './schedule-stats.repository.js';

/**
 * 53-06 — critical path, float and schedule health, kept per project in `work_item_schedule_stats`.
 *
 * - **Recompute** reads the project's live items and the active edges into them in one transaction,
 *   runs the domain's `criticalPath` in the company calendar (a predecessor in another project is
 *   passed as a fixed external date, never named), and replaces the project's rows under one
 *   `batch_id`. A project over {@link MAX_GRAPH_NODES} items answers 422 `project_too_large` and its
 *   old rows stay.
 * - **Debounce**: a schedule change calls {@link requestScheduleRecompute}; requests for one project
 *   coalesce into one run {@link SCHEDULE_RECOMPUTE_DEBOUNCE_MS} after the last (in-process timers,
 *   `unref`'d, so a pending run never holds the process open). Lost on restart by design: the read's
 *   lazy path recomputes rows older than the project's newest item change.
 * - **Reads** are `work.read` plus the project relation (404 when the caller may not see the
 *   project, as `ProjectHealthService`); client principals never get the stats. Items the caller
 *   cannot read are left out, and critical drivers they cannot read are counted, never named.
 */

export const SCHEDULE_RECOMPUTE_DEBOUNCE_MS = 2_000;
export const SCHEDULE_DRIVER_COUNT = 3;

export interface CriticalPathItem {
  readonly id: string;
  readonly earlyStart: string | null;
  readonly earlyFinish: string | null;
  readonly lateStart: string | null;
  readonly lateFinish: string | null;
  readonly totalFloatDays: number | null;
  readonly isCritical: boolean;
}

export interface ScheduleDriver {
  readonly id: string;
  readonly title: string;
}

/** `GET …/projects/:projectId/schedule/critical-path`. Not a `…View`: no web consumer yet. */
export interface CriticalPathResponse {
  readonly projectId: string;
  readonly computedAt: string | null;
  readonly batchId: string | null;
  readonly criticalEndDate: string | null;
  readonly criticalCount: number;
  readonly unscheduledCount: number;
  readonly items: readonly CriticalPathItem[];
  readonly drivers: readonly ScheduleDriver[];
  readonly hiddenDrivers: number;
}

export interface RecomputeOutcome {
  readonly batchId: string;
  readonly computedAt: Date;
  readonly items: number;
  readonly edges: number;
  readonly unscheduled: number;
}

let registered: ScheduleStatsService | null = null;

/** The module wires the running service here; without one (unit tests) requests are dropped. */
export function registerScheduleStats(service: ScheduleStatsService | null): void {
  registered = service;
}

/** Ask for a debounced recompute of each named project. Never throws, never waits. */
export function requestScheduleRecompute(
  context: TenantContext,
  ...projectIds: readonly (string | null | undefined)[]
): void {
  const service = registered;
  if (!service) return;
  for (const projectId of new Set(projectIds)) {
    if (projectId) service.requestRecompute(context, projectId);
  }
}

/** The topmost critical items (latest early finish first) — the rows are already in that order. */
export function driversOf(
  rows: readonly ScheduleStatsItemRow[],
  mayRead: (row: ScheduleStatsItemRow) => boolean,
): { drivers: ScheduleDriver[]; hiddenDrivers: number } {
  const top = rows.filter((r) => r.isCritical).slice(0, SCHEDULE_DRIVER_COUNT);
  const drivers = top.filter(mayRead).map((r) => ({ id: r.workItemId, title: r.title }));
  return { drivers, hiddenDrivers: top.length - drivers.length };
}

export function mayReadItem(
  principal: Principal,
  row: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly audience: Audience;
    readonly state: string;
  },
): boolean {
  return authorize({
    principal,
    capability: 'work.read',
    resource: {
      organizationId: row.organizationId,
      projectId: row.projectId,
      audience: row.audience,
      lifecycle: row.state === 'archived' ? 'archived' : 'active',
    },
  }).allowed;
}

export class ScheduleStatsService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly logger = new Logger('ScheduleStats');

  constructor(
    private readonly database: TenantDatabase,
    private readonly stats: ScheduleStatsRepository = new ScheduleStatsRepository(),
    private readonly audit?: AuditService,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly calendars: WorkingCalendarRepository = new WorkingCalendarRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Coalesce to one recompute {@link SCHEDULE_RECOMPUTE_DEBOUNCE_MS} after the last request. */
  requestRecompute(context: TenantContext, projectId: string): void {
    const key = `${context.organizationId}:${projectId}`;
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.recompute(context, projectId).catch((error: unknown) => {
        this.logger.warn(
          `schedule recompute failed ${JSON.stringify({ projectId, error: (error as Error)?.name })}`,
        );
      });
    }, SCHEDULE_RECOMPUTE_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Recompute now, in a transaction of its own. */
  async recompute(context: TenantContext, projectId: string): Promise<RecomputeOutcome> {
    return this.database.transaction(context, (tx) => this.recomputeIn(tx, context, projectId));
  }

  async criticalPathOf(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<CriticalPathResponse> {
    await this.requireProject(context, principal, projectId, 'work.read');
    let rows = await this.database.read(context, (r) =>
      this.stats.listProjectStats(r, context, projectId),
    );
    const latest = await this.database.read(context, (r) =>
      this.stats.latestItemChange(r, context, projectId),
    );
    let unscheduled: number | null = null;
    const stale =
      rows.length === 0 || (latest !== null && rows[0]!.computedAt.getTime() < latest.getTime());
    if (stale && latest !== null) {
      unscheduled = (await this.recompute(context, projectId)).unscheduled;
      rows = await this.database.read(context, (r) =>
        this.stats.listProjectStats(r, context, projectId),
      );
    }
    return this.responseOf(context, principal, projectId, rows, unscheduled);
  }

  /** `project.manage`: recompute at once, audited `schedule.recomputed`. */
  async recomputeNow(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<CriticalPathResponse> {
    await this.requireProject(context, principal, projectId, 'project.manage');
    const outcome = await this.database.transaction(context, async (tx) => {
      const result = await this.recomputeIn(tx, context, projectId);
      await this.audit?.record(tx, context, {
        action: 'schedule.recomputed',
        objectId: projectId,
        result: 'allowed',
        metadata: { project_id: projectId, batch_id: result.batchId, items: result.items },
      });
      return result;
    });
    const rows = await this.database.read(context, (r) =>
      this.stats.listProjectStats(r, context, projectId),
    );
    return this.responseOf(context, principal, projectId, rows, outcome.unscheduled);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async recomputeIn(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<RecomputeOutcome> {
    const started = Date.now();
    const items = await this.stats.listProjectItems(tx, context, projectId, MAX_GRAPH_NODES + 1);
    if (items.length > MAX_GRAPH_NODES) {
      throw new ApiError(
        422,
        'validation_failed',
        `A project over ${MAX_GRAPH_NODES} items is too large to schedule`,
        [{ field: 'projectId', message: 'project_too_large' }],
        'project_too_large',
      );
    }
    const inProject = new Set(items.map((i) => i.id));
    const edgeRows = await this.stats.listProjectEdges(tx, context, projectId);
    const edges: TypedDependencyEdge[] = edgeRows
      .filter((e) => isDependencyKind(e.kind))
      .map((e) => ({
        workItemId: e.workItemId,
        dependsOnWorkItemId: e.dependsOnWorkItemId,
        kind: e.kind as TypedDependencyEdge['kind'],
        lag: e.lag,
      }));
    const outside = [
      ...new Set(edges.map((e) => e.dependsOnWorkItemId).filter((id) => !inProject.has(id))),
    ];
    const externals = await this.stats.findItemDates(tx, context, outside);
    const calendar = await this.calendarOf(tx, context);
    const local = (at: Date | null) => (at ? localDateOf(at, calendar.timeZone) : null);

    let result;
    try {
      result = criticalPath({
        calendar,
        items: items.map((i) => ({
          id: i.id,
          projectId,
          startAt: local(i.startAt),
          dueAt: local(i.dueAt),
        })),
        edges,
        external: externals.map((e) => ({
          id: e.id,
          startAt: local(e.startAt),
          dueAt: local(e.dueAt),
        })),
      });
    } catch (error) {
      if (error instanceof WorkingCalendarRangeError || error instanceof DependencyCycleDetected) {
        throw new ApiError(422, 'validation_failed', 'The project schedule cannot be computed');
      }
      throw error;
    }

    const batchId = uuidv7();
    const computedAt = this.now();
    await this.stats.replaceProject(
      tx,
      context,
      projectId,
      { batchId, computedAt },
      result.rows.map((r) => ({
        workItemId: r.id,
        earlyStart: r.earlyStart,
        earlyFinish: r.earlyFinish,
        lateStart: r.lateStart,
        lateFinish: r.lateFinish,
        totalFloatDays: r.totalFloatDays,
        isCritical: r.isCritical,
      })),
    );
    this.logger.log(
      `schedule recomputed ${JSON.stringify({
        batchId,
        projectId,
        items: items.length,
        edges: edges.length,
        ms: Date.now() - started,
      })}`,
    );
    return {
      batchId,
      computedAt,
      items: result.rows.length,
      edges: edges.length,
      unscheduled: result.unscheduled.length,
    };
  }

  private async responseOf(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    rows: readonly ScheduleStatsItemRow[],
    unscheduled: number | null,
  ): Promise<CriticalPathResponse> {
    const mayRead = (row: ScheduleStatsItemRow) => mayReadItem(principal, row);
    const { drivers, hiddenDrivers } = driversOf(rows, mayRead);
    let criticalEndDate: string | null = null;
    for (const row of rows) {
      if (
        row.earlyFinish !== null &&
        (criticalEndDate === null || row.earlyFinish > criticalEndDate)
      )
        criticalEndDate = row.earlyFinish;
    }
    const unscheduledCount =
      unscheduled ??
      (await this.database.read(context, (r) => this.stats.countLiveItems(r, context, projectId))) -
        rows.length;
    return {
      projectId,
      computedAt: rows[0]?.computedAt.toISOString() ?? null,
      batchId: rows[0]?.batchId ?? null,
      criticalEndDate,
      criticalCount: rows.filter((r) => r.isCritical).length,
      unscheduledCount: Math.max(0, unscheduledCount),
      items: rows.filter(mayRead).map((r) => ({
        id: r.workItemId,
        earlyStart: r.earlyStart,
        earlyFinish: r.earlyFinish,
        lateStart: r.lateStart,
        lateFinish: r.lateFinish,
        totalFloatDays: r.totalFloatDays,
        isCritical: r.isCritical,
      })),
      drivers,
      hiddenDrivers,
    };
  }

  /** Not found unless the caller holds `capability` on the project; never for a client principal. */
  private async requireProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
  ): Promise<void> {
    const project = await this.database.read(context, (r) =>
      this.projects.findById(r, context, projectId),
    );
    const resource = project && {
      organizationId: project.organizationId,
      projectId: project.id,
      audience: 'internal' as const,
      lifecycle: project.archivedAt ? ('archived' as const) : ('active' as const),
    };
    const visible =
      resource !== null &&
      principal.kind !== 'client' &&
      authorize({ principal, capability: 'work.read', resource }).allowed;
    if (!visible) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    if (capability !== 'work.read' && !authorize({ principal, capability, resource }).allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
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
