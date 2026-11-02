import {
  authorize,
  cascade,
  dayNumberOf,
  defaultWorkingCalendar,
  localDateOf,
  WorkingCalendarRangeError,
} from '@tmanage/domain';
import type {
  Capability,
  DependencyKind,
  Principal,
  ScheduleItem,
  WorkingCalendar,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { WorkItemsRepository, WorkItemVersionConflictError } from './work-items.repository.js';
import { WorkGraphRepository } from './work-graph.repository.js';

/**
 * 53-04 — editing a typed edge in place, and the schedule cascade (preview, then apply).
 *
 * 53-03's Gantt `schedule` endpoint does not exist yet, so the cascade has its own two routes.
 * There is no `schedule_mode` column — every successor is `auto` — and no `schedule_change_log`,
 * so each moved item gets a `work_item.rescheduled` audit row with its dates before and after.
 * The capability the plan calls `schedule.manage` is `project.manage` here (the matrix has no
 * schedule capability): a cascade that crosses into other projects needs it on each of them.
 *
 * Dates move in whole calendar days of the company calendar (the org calendar, else the default
 * Sun–Thu one): an item's instant keeps its time of day and slides by the days `cascade()` moved
 * its civil date. Work updates emit no outbox event today, so neither does a cascade.
 *
 * Disclosure: a successor the caller cannot read is counted (`hiddenCount`), never named.
 */

/** A cascade may move work in at most this many projects (the root's included). */
export const MAX_CASCADE_PROJECTS = 3;
const MS_PER_DAY = 86_400_000;

export interface CascadeMoveView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly deltaWorkingDays: number;
}

export interface CascadePlanView {
  readonly workItemId: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly moves: readonly CascadeMoveView[];
  readonly hiddenCount: number;
  /** Moved items (readable ones) that sit in a project other than the root's. */
  readonly crossProjectIds: readonly string[];
  /** Reached successors (readable ones) with no dates: nothing to move. */
  readonly unscheduled: readonly string[];
}

export interface DependencyEditView {
  readonly id: string;
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
  readonly kind: string;
  readonly lagWorkingDays: number;
  readonly status: string;
}

interface PlannedMove {
  readonly row: WorkItemRow;
  readonly startAt: Date | null;
  readonly dueAt: Date | null;
  readonly deltaWorkingDays: number;
}

interface Plan {
  readonly root: WorkItemRow;
  readonly startAt: Date | null;
  readonly dueAt: Date | null;
  readonly moves: readonly PlannedMove[];
  readonly unscheduled: readonly WorkItemRow[];
}

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

export class ScheduleCascadeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    private readonly audit?: AuditService,
    private readonly graph: WorkGraphRepository = new WorkGraphRepository(),
    private readonly calendars: WorkingCalendarRepository = new WorkingCalendarRepository(),
  ) {}

  /** PATCH an edge's kind and/or lag. `work.update` on the dependent item; audited. */
  async updateDependency(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dependencyId: string,
    change: { readonly kind?: DependencyKind; readonly lag?: number },
  ): Promise<DependencyEditView> {
    const item = await this.database.read(context, (r) =>
      this.workItems.findById(r, context, workItemId),
    );
    this.requireWritable(principal, item, 'work.update');
    return this.database.transaction(context, async (tx) => {
      const before = await this.graph.findDependency(tx, context, workItemId, dependencyId);
      if (!before) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const kind = change.kind ?? (before.kind as DependencyKind);
      const lag = change.lag ?? Number(before.lagWorkingDays);
      const after = await this.graph.updateDependency(tx, context, dependencyId, { kind, lag });
      await this.audit?.record(tx, context, {
        action: 'work_item.dependency_changed',
        objectId: workItemId,
        result: 'allowed',
        metadata: {
          dependency_id: dependencyId,
          kind_before: before.kind,
          kind_after: kind,
          lag_before: Number(before.lagWorkingDays),
          lag_after: lag,
        },
      });
      return {
        id: after.id,
        workItemId: after.workItemId,
        dependsOnWorkItemId: after.dependsOnWorkItemId,
        kind: after.kind,
        lagWorkingDays: Number(after.lagWorkingDays),
        status: after.status,
      };
    });
  }

  /** What moving this item would do to its successors. Nothing is written. */
  async preview(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dates: { readonly startAt: Date | null; readonly dueAt: Date | null },
  ): Promise<CascadePlanView> {
    const plan = await this.database.read(context, (r) =>
      this.plan(r, context, principal, workItemId, dates),
    );
    return this.viewOf(principal, plan);
  }

  /**
   * Move the item and its successors in one transaction. The plan is recomputed and must name
   * the same readable successors the caller previewed (`expectedMoves`), else 409 — the graph
   * or someone's dates changed in between, and the caller has not seen what would happen now.
   */
  async apply(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dates: { readonly startAt: Date | null; readonly dueAt: Date | null },
    expectedMoves: readonly string[],
  ): Promise<CascadePlanView> {
    try {
      return await this.database.transaction(context, async (tx) => {
        const plan = await this.plan(tx, context, principal, workItemId, dates);
        const view = this.viewOf(principal, plan);
        const seen = new Set(view.moves.map((m) => m.id));
        const expected = new Set(expectedMoves);
        if (seen.size !== expected.size || [...seen].some((id) => !expected.has(id))) {
          throw new ApiError(
            409,
            'conflict',
            'The schedule changed since the preview; preview it again',
            [{ field: 'expectedMoves', message: 'cascade_changed' }],
            'cascade_changed',
          );
        }
        this.authorizeMoves(context, principal, plan);

        const writes = [
          { row: plan.root, startAt: plan.startAt, dueAt: plan.dueAt },
          ...plan.moves,
        ];
        for (const write of writes) {
          await this.workItems.update(tx, context, write.row.id, Number(write.row.version), {
            startAt: write.startAt,
            dueAt: write.dueAt,
          });
          await this.audit?.record(tx, context, {
            action: 'work_item.rescheduled',
            objectId: write.row.id,
            result: 'allowed',
            metadata: {
              project_id: write.row.projectId,
              root_work_item_id: plan.root.id,
              start_before: iso(write.row.startAt),
              start_after: iso(write.startAt),
              due_before: iso(write.row.dueAt),
              due_after: iso(write.dueAt),
            },
          });
        }
        return view;
      });
    } catch (error) {
      if (error instanceof WorkItemVersionConflictError) {
        throw new ApiError(409, 'conflict', 'A work item changed during the cascade; try again');
      }
      throw error;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async plan(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dates: { readonly startAt: Date | null; readonly dueAt: Date | null },
  ): Promise<Plan> {
    const root = await this.workItems.findById(runner, context, workItemId);
    this.requireWritable(principal, root, 'work.update');
    const calendar = await this.calendarOf(runner, context);
    const allEdges = await this.graph.listActiveEdgesFrom(runner, context, workItemId);
    const ids = new Set<string>([workItemId]);
    for (const e of allEdges) ids.add(e.workItemId).add(e.dependsOnWorkItemId);
    const rows = (await this.workItems.findManyByIds(runner, context, [...ids])).filter(
      (r) => r.deletedAt === null,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const edges = allEdges.filter((e) => byId.has(e.workItemId) && byId.has(e.dependsOnWorkItemId));

    const local = (at: Date | null) => (at ? localDateOf(at, calendar.timeZone) : null);
    const items: ScheduleItem[] = rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      startAt: local(r.startAt),
      dueAt: local(r.dueAt),
    }));
    let result;
    try {
      result = cascade({
        items,
        edges,
        moved: { id: workItemId, startAt: local(dates.startAt), dueAt: local(dates.dueAt) },
        calendar,
      });
    } catch (error) {
      if (error instanceof WorkingCalendarRangeError) {
        throw new ApiError(422, 'validation_failed', 'The dates are outside the planning horizon');
      }
      throw error;
    }
    // Slide each instant by the civil days its date moved; the time of day is kept.
    const shift = (at: Date | null, from: string | null, to: string | null): Date | null =>
      at && from && to
        ? new Date(at.getTime() + (dayNumberOf(to) - dayNumberOf(from)) * MS_PER_DAY)
        : at;
    const moves = result.moves.map((m) => {
      const row = byId.get(m.id) as WorkItemRow;
      return {
        row,
        startAt: shift(row.startAt, local(row.startAt), m.startAt),
        dueAt: shift(row.dueAt, local(row.dueAt), m.dueAt),
        deltaWorkingDays: m.deltaWorkingDays,
      };
    });
    return {
      root: root as WorkItemRow,
      startAt: dates.startAt,
      dueAt: dates.dueAt,
      moves,
      unscheduled: result.unscheduled.map((id) => byId.get(id) as WorkItemRow),
    };
  }

  private viewOf(principal: Principal, plan: Plan): CascadePlanView {
    const visible = plan.moves.filter((m) => this.mayRead(principal, m.row));
    return {
      workItemId: plan.root.id,
      startAt: iso(plan.startAt),
      dueAt: iso(plan.dueAt),
      moves: visible.map((m) => ({
        id: m.row.id,
        projectId: m.row.projectId,
        title: m.row.title,
        startAt: iso(m.startAt),
        dueAt: iso(m.dueAt),
        deltaWorkingDays: m.deltaWorkingDays,
      })),
      hiddenCount: plan.moves.length - visible.length,
      crossProjectIds: visible
        .filter((m) => m.row.projectId !== plan.root.projectId)
        .map((m) => m.row.id),
      unscheduled: plan.unscheduled.filter((r) => this.mayRead(principal, r)).map((r) => r.id),
    };
  }

  /** `work.update` on every moved item; `project.manage` on each project a cross-project move touches. */
  private authorizeMoves(context: TenantContext, principal: Principal, plan: Plan): void {
    for (const move of plan.moves) {
      if (!this.allowed(principal, move.row, 'work.update')) {
        // Name the refused item only when the caller can read it; otherwise it stays hidden.
        const named = this.mayRead(principal, move.row) ? move.row.id : 'hidden';
        throw new ApiError(403, 'forbidden', `You cannot reschedule ${named}`);
      }
    }
    const projects = new Set([plan.root.projectId, ...plan.moves.map((m) => m.row.projectId)]);
    if (projects.size === 1) return;
    if (projects.size > MAX_CASCADE_PROJECTS) {
      throw new ApiError(422, 'validation_failed', 'A cascade may move work in at most 3 projects');
    }
    for (const projectId of projects) {
      const verdict = authorize({
        principal,
        capability: 'project.manage',
        resource: {
          organizationId: context.organizationId,
          projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      });
      if (!verdict.allowed) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
      }
    }
  }

  private requireWritable(
    principal: Principal,
    row: WorkItemRow | null,
    capability: Capability,
  ): asserts row is WorkItemRow {
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (!this.allowed(principal, row, capability)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return row.deletedAt === null && this.allowed(principal, row, 'work.read');
  }

  private allowed(principal: Principal, row: WorkItemRow, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.state === 'archived' ? 'archived' : 'active',
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
