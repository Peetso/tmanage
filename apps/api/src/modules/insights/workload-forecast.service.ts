import { authorize } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { WorkloadForecastRepository } from './workload-forecast.repository.js';

/**
 * x134 — Insights workload forecasting (`38-MODULE-MAP` §Insights, forecasting deferred at NS-11).
 *
 * A forward-looking counterpart to INS-05's *current* workload roll-up: INS-05 answers "what is on
 * people's plates now", this answers "what is committed to land in the upcoming weeks, and does any
 * week's committed work exceed the team's capacity". Both are pure reads over the same `work_items`
 * facts; neither adds a column, a write or a schedule.
 *
 * ## Deterministic, no ML
 *
 * The projection is arithmetic, not a model. A work item is *committed* to a week when it is open
 * and carries a `dueAt`; it lands in the upcoming week its `dueAt` falls in (overdue committed work
 * folds into week 1, since it is already due; work due beyond the horizon is not counted). Capacity
 * is a **constant per member** — the recommended option while `work_items` has no assignee column
 * (the HOME-04 gap; a real capacity model is deferred to NS-13). "Members" are the distinct owners
 * carrying open work the caller may read — INS-05's *capacity in use* — so the forecast compares a
 * week's committed load against `memberCount × {@link PER_MEMBER_WEEKLY_CAPACITY}` and flags the
 * weeks that exceed it. Same input, same output, every time.
 *
 * ## Capability and scope
 *
 * Behind `work.read` on the route (the internal-read capability INS-01/05 reuse — no capability
 * table or role-grid edit, no migration). The scope is INS-05's exactly, including the FAST-PROTOCOL
 * Known-trap: the projects are enumerated tenant-scoped, and **every project is authorized against
 * its own `organizationId` before its items are read**, so a cross-tenant project never fans out a
 * read (excluded, never a 500) and a non-org-wide caller only sees the projects they are on. A
 * caller off every project — or a client, whom `work.read` never grants — gets an empty forecast,
 * not a refusal; the route's role ceiling is the 403, the relation half is a filter. Every work row
 * is re-checked by {@link mayRead} (belt-and-braces to the tenant-scoped, open-state-filtered SQL).
 */

/**
 * The audiences a client principal may read — mirrors {@link InsightsService}'s constant. `internal`
 * is absent, and that absence is the control. A client never passes the internal-only `work.read`
 * ceiling here anyway, so this is defence in depth applied consistently, not the primary gate.
 */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

/**
 * The "open" states — every work-item state except `done` and the terminal `archived`. Identical to
 * INS-05's list: a forecast of committed work must not count completed or archived work.
 */
const OPEN_WORK_STATES: readonly WorkItemState[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
];

/** The project fan-out bound, as INS-05: default 20, hard ceiling 50, never an unbounded walk. */
const DEFAULT_FORECAST_PROJECT_LIMIT = 20;
const MAX_FORECAST_PROJECT_LIMIT = 50;

/** The forecast horizon bounds — a caller may ask for 1..12 upcoming weeks; the default is 4. */
export const MIN_FORECAST_WEEKS = 1;
export const MAX_FORECAST_WEEKS = 12;
export const DEFAULT_FORECAST_WEEKS = 4;

/** A week is seven days; capacity and the week buckets are both computed against this constant. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The placeholder capacity model: how much committed work one member is assumed to absorb in a week.
 * Constant on purpose — a real, per-member capacity needs a `work_items` assignee column that does
 * not exist yet (HOME-04 gap), so NS-13 owns the real model. A week's team capacity is this times
 * the distinct members carrying open work in scope.
 */
const PER_MEMBER_WEEKLY_CAPACITY = 5;

/**
 * One upcoming week in the forecast. `startsAt` is the ISO instant the week opens (relative to when
 * the read ran); `committedItemCount` is the open, dated work the caller may read that is due in it;
 * `capacity` is the constant team capacity for the week; `overCapacity` is `committedItemCount >
 * capacity`.
 */
export interface WorkloadForecastWeek {
  readonly weekIndex: number;
  readonly startsAt: string;
  readonly committedItemCount: number;
  readonly capacity: number;
  readonly overCapacity: boolean;
}

/**
 * The forecast aggregate. `weeks` is the horizon; `memberCount` the distinct owners carrying open
 * work in scope (the capacity basis); `committedItemCount` the committed work across the horizon;
 * `capacity` the summed weekly capacity; `overCapacityWeekCount` how many weeks exceed theirs.
 */
export interface WorkloadForecastTotals {
  readonly weeks: number;
  readonly memberCount: number;
  readonly committedItemCount: number;
  readonly capacity: number;
  readonly overCapacityWeekCount: number;
}

/**
 * x134's read shape — the workload forecast. `weeks` is the per-week breakdown (chronological),
 * `totals` the aggregate across them. Computed, never stored. Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the forecast screen consumes (CONTRACT-001).
 */
export interface WorkloadForecastView {
  readonly weeks: readonly WorkloadForecastWeek[];
  readonly totals: WorkloadForecastTotals;
  readonly computedAt: string;
}

/** Options for the forecast — the validated horizon the controller passes through. */
export interface WorkloadForecastOptions {
  /** The horizon in upcoming weeks. The controller has already validated it into `[1, 12]`. */
  readonly weeks: number;
}

/** The requested project bound, clamped to `[1, 50]`; a missing or non-finite value is the default 20. */
function clampProjectLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_FORECAST_PROJECT_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_FORECAST_PROJECT_LIMIT);
}

/** The horizon, clamped to `[1, 12]`; a missing or non-finite value is the default 4. Belt-and-braces to the controller's 400. */
function clampWeeks(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_FORECAST_WEEKS;
  return Math.min(Math.max(Math.trunc(raw), MIN_FORECAST_WEEKS), MAX_FORECAST_WEEKS);
}

export class WorkloadForecastService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: WorkloadForecastRepository,
  ) {}

  /**
   * The workload forecast for this principal: committed open work projected into the upcoming weeks
   * against a constant per-member capacity, across the projects they may read. A pure read; see the
   * class doc for the scope and the Known-trap the per-project authorize enforces.
   */
  async forecast(
    context: TenantContext,
    principal: Principal,
    options: WorkloadForecastOptions,
  ): Promise<WorkloadForecastView> {
    const now = new Date();
    const weeks = clampWeeks(options.weeks);
    const horizonStart = now.getTime();
    const horizonEnd = horizonStart + weeks * WEEK_MS;
    const audiences = principal.kind === 'client' ? CLIENT_AUDIENCES : undefined;

    const committedByWeek = new Array<number>(weeks).fill(0);
    const owners = new Set<string>();

    await this.database.read(context, async (runner) => {
      const projectRows = await this.repository.listProjects(runner, context, {
        limit: clampProjectLimit(undefined),
      });

      for (const project of projectRows) {
        // Resolve-before-relation-check (Known-trap): a cross-tenant project is refused by the
        // tenant check inside authorize (against the project's own org), so it never fans out a
        // read; a non-org-wide caller only passes for a project they are on.
        if (!this.mayReadProject(principal, project)) continue;

        const items = await this.repository.listOpenProjectItems(
          runner,
          context,
          project.id,
          OPEN_WORK_STATES,
          { ...(audiences ? { audiences } : {}) },
        );

        for (const row of items) {
          // Belt-and-braces to the tenant-scoped, open-state-filtered SQL.
          if (!this.mayRead(principal, row)) continue;
          if (row.ownerUserId !== null) owners.add(row.ownerUserId);
          if (row.dueAt === null) continue; // undated open work is not committed to a week

          const bucket = weekBucket(row.dueAt.getTime(), horizonStart, horizonEnd, weeks);
          if (bucket !== null) committedByWeek[bucket] += 1;
        }
      }
    });

    const memberCount = owners.size;
    const weeklyCapacity = memberCount * PER_MEMBER_WEEKLY_CAPACITY;

    const weekViews: WorkloadForecastWeek[] = committedByWeek.map((committedItemCount, index) => ({
      weekIndex: index + 1,
      startsAt: new Date(horizonStart + index * WEEK_MS).toISOString(),
      committedItemCount,
      capacity: weeklyCapacity,
      overCapacity: committedItemCount > weeklyCapacity,
    }));

    return {
      weeks: weekViews,
      totals: {
        weeks,
        memberCount,
        committedItemCount: weekViews.reduce((sum, week) => sum + week.committedItemCount, 0),
        capacity: weeklyCapacity * weeks,
        overCapacityWeekCount: weekViews.filter((week) => week.overCapacity).length,
      },
      computedAt: now.toISOString(),
    };
  }

  /**
   * Whether this principal may read a project, judged by `work.read` against the project's **own**
   * organization and id — INS-05's `mayReadProject` exactly. Authorizing against the row's own
   * `organizationId` (not the context's) is the belt-and-braces that refuses a cross-tenant row.
   */
  private mayReadProject(principal: Principal, project: ProjectRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Whether this principal may read a work item, judged by `work.read` against the item's own
   * project and audience — INS-05's `mayRead` exactly. The relation half of the route capability.
   */
  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.deletedAt
          ? 'soft_deleted'
          : row.state === 'archived'
            ? 'archived'
            : 'active',
      },
    }).allowed;
  }
}

/**
 * The upcoming-week bucket a due instant falls in, or `null` when it is beyond the horizon. Overdue
 * committed work (due before the horizon opened) folds into week 0 — it is already due, so it counts
 * against the nearest week's capacity rather than vanishing.
 */
function weekBucket(
  dueMs: number,
  horizonStart: number,
  horizonEnd: number,
  weeks: number,
): number | null {
  if (dueMs >= horizonEnd) return null;
  if (dueMs < horizonStart) return 0;
  return Math.min(Math.floor((dueMs - horizonStart) / WEEK_MS), weeks - 1);
}
