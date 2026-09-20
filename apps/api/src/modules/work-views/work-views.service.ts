import { authorize, isWorkItemState } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { logUnrecognisedRowState } from '../../common/observability/logger.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import { ProjectNotFoundError, ProjectsRepository } from '../projects/projects.repository.js';
import { WorkTimelineRepository } from './timeline.repository.js';
import { WorkCalendarRepository } from './calendar.repository.js';

/**
 * WK-04 Work timeline — a read-only *view* over WORK-001 and WORK-003, composed here.
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-04 asks for a timeline of "Milestones/
 * dependencies … accessible list". Every fact it needs is already stored and already read, so
 * this service adds no table, no migration and no read method to the work module (which x88
 * edits in parallel — NEXT-SCOPES §x94). It composes {@link WorkTimelineRepository}'s two
 * borrowed reads and applies the policy the repository leaves out, the way `WorkItemsService`
 * splits its own repository and rules.
 *
 * ## The two rules it owns
 *
 * - **`mayRead` per item, belt-and-braces to the tenant-scoped SQL.** The query is already
 *   scoped, but `authorize()` is the one place the read rule is written, so every row is passed
 *   through it and a cross-tenant or unrelated row never reaches the timeline — the same
 *   `resourceOf`/`authorize` check `WorkItemsService.list` applies. A client principal is also
 *   narrowed to the client audiences *before* the query, so an internal item is never fetched.
 * - **Predecessor edges are redacted, not disclosed, when the caller may not read them.** A
 *   dependency can cross a project boundary (linked by an org-wide admin, or read access revoked
 *   after the edge was made). Each predecessor is authorized against its **own** project and
 *   audience before its id joins the timeline — R01 / tenant-isolation audit F3 — so an edge to
 *   work the caller cannot see is simply absent rather than a leaked id. A soft-deleted
 *   predecessor is dropped for the same reason `deriveHealth` drops it: it is not a live edge.
 *
 * ## The order, and the empty value
 *
 * Items are ordered **for a timeline** — by `startAt`, then `dueAt`, then `id` — with a missing
 * date sorting last within its key, because "no date set" belongs after everything that has one.
 * A project with no items the caller may read is the documented empty value: `items: []`.
 */

/** One row of the accessible timeline: the item's dates, its state, and its readable predecessors. */
export interface WorkTimelineItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  /** The ids of the predecessors this caller may read; a redacted edge is absent, not named. */
  readonly predecessorIds: readonly string[];
}

/**
 * The timeline read's response — WK-04's `WorkTimelineView`, paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the accessible-list screen consumes
 * (CONTRACT-001). `organizationId` is absent: the caller already knows which organization and
 * project they asked about.
 */
export interface WorkTimelineView {
  readonly projectId: string;
  readonly items: readonly WorkTimelineItem[];
}

/**
 * The audiences a client principal may read — `internal` absent by design, the control that
 * decides what a client can ever see. Identical to `WorkItemsService`'s allowlist; a client
 * timeline is a narrower view of the same rows, never a way to the internal ones.
 */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

/**
 * WK-05 Work calendar — a read-only *view* over WORK-001, composed here like the timeline.
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-05 asks for a calendar of the project's work.
 * Every fact it needs — a work item's dates — is already stored and already read, so this view
 * adds no table, no migration and no read method to the work module: it buckets the same
 * {@link WorkCalendarRepository}-composed `list` the timeline and list screens run.
 *
 * ## The rules it owns
 *
 * - **The project is resolved tenant-scoped first.** An org-wide caller passes the per-item
 *   read below, so a projectId that is unknown or belongs to another organization must be
 *   turned away as **404** here rather than silently returning an empty calendar (FAST-PROTOCOL
 *   known trap — resolve any named project id before the relation check).
 * - **`mayRead` per item, belt-and-braces to the tenant-scoped SQL**, plus the client-audience
 *   pre-filter — identical to `projectTimeline`, so a cross-tenant or unreadable item never
 *   reaches a day cell and a client sees only client-audience items.
 *
 * ## The bucket, the range, the order, and the empty value
 *
 * Each item is placed on **one** day — its *anchor day*, the UTC calendar day of `dueAt`, or of
 * `startAt` when it has no due date. A work calendar answers "what is due on this day"; an item
 * with a due date belongs on it, and one with only a start date belongs on the day it begins.
 * An item with **no date at all** is not placed on any day (the documented rule for a dateless
 * item), and an item whose anchor day falls outside the requested `[from, to]` range is excluded
 * (day granularity, both ends inclusive). Only days that carry at least one item are emitted, in
 * ascending date order; within a day, items are ordered by `startAt`, then `dueAt`, then `id`.
 * A project with no in-range readable items is the documented empty value: `days: []`.
 */

/** One item on the calendar: its dates and state. No `View` suffix — the paired shape is {@link WorkCalendarView}. */
export interface WorkCalendarItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

/** One day cell: the `YYYY-MM-DD` date and the items anchored on it, deterministically ordered. */
export interface WorkCalendarDay {
  readonly date: string;
  readonly items: readonly WorkCalendarItem[];
}

/** The requested range, echoed so the screen can lay out a grid the response only fills. */
export interface WorkCalendarRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The calendar read's response — WK-05's `WorkCalendarView`, paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the accessible Calendar screen consumes
 * (CONTRACT-001). `organizationId` is absent: the caller already knows which organization and
 * project they asked about.
 */
export interface WorkCalendarView {
  readonly projectId: string;
  readonly range: WorkCalendarRange;
  readonly days: readonly WorkCalendarDay[];
}

export class WorkViewsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly timeline: WorkTimelineRepository = new WorkTimelineRepository(),
    private readonly calendar: WorkCalendarRepository = new WorkCalendarRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * The project's work items with their dates and predecessor edges, ordered for a timeline and
   * scoped to what this principal may read. A pure read: no write, no new column, no schedule.
   */
  async projectTimeline(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<WorkTimelineView> {
    const rows = await this.database.read(context, (runner) =>
      this.timeline.listProjectTimeline(runner, context, projectId, {
        ...(principal.kind === 'client' ? { audiences: CLIENT_AUDIENCES } : {}),
      }),
    );

    const items: WorkTimelineItem[] = [];
    for (const { item, predecessors } of rows) {
      // Belt-and-braces to the tenant-scoped SQL: a cross-tenant or unrelated row is refused
      // here as well as by the query, and a client sees only client-audience items.
      if (!this.mayRead(principal, item)) continue;

      const predecessorIds: string[] = [];
      for (const predecessor of predecessors) {
        if (predecessor.deletedAt !== null) continue; // Not a live edge.
        // Authorize each predecessor against its own project and audience before its id shows.
        if (!this.mayReadPredecessor(context, principal, predecessor)) continue;
        predecessorIds.push(predecessor.workItemId);
      }

      items.push({
        id: item.id,
        title: item.title,
        state: this.stateOf(item, context),
        startAt: item.startAt ? item.startAt.toISOString() : null,
        dueAt: item.dueAt ? item.dueAt.toISOString() : null,
        predecessorIds,
      });
    }

    items.sort(compareForTimeline);
    return { projectId, items };
  }

  /**
   * The project's open work items bucketed by their anchor day into the requested range, scoped
   * to what this principal may read. A pure read: no write, no new column, no schedule.
   *
   * The named project is resolved inside this tenant **before** anything is bucketed — an
   * unknown or cross-tenant id is a 404 (`ProjectNotFoundError`), not a misleading empty
   * calendar, closing the trap an org-wide caller would otherwise drive through the per-item read.
   */
  async projectCalendar(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    range: WorkCalendarRange,
  ): Promise<WorkCalendarView> {
    const resolved = await this.database.read(context, async (runner) => {
      const project = await this.projects.findById(runner, context, projectId);
      if (!project) return null;
      const rows = await this.calendar.listProjectItems(runner, context, projectId, {
        ...(principal.kind === 'client' ? { audiences: CLIENT_AUDIENCES } : {}),
      });
      return { rows };
    });

    // Resolve-before-relation-check: a projectId that names nothing in this tenant is not found.
    if (resolved === null) throw new ProjectNotFoundError(projectId);

    const byDay = new Map<string, WorkCalendarItem[]>();
    for (const item of resolved.rows) {
      // Belt-and-braces to the tenant-scoped SQL: a cross-tenant or unrelated row is refused here
      // as well as by the query, and a client sees only client-audience items.
      if (!this.mayRead(principal, item)) continue;

      // A calendar answers "what is due on this day": anchor on the due date, or the start date
      // when there is no due date. An item with neither is not on the calendar at all.
      const anchor = item.dueAt ?? item.startAt;
      if (anchor === null) continue;
      const day = anchor.toISOString().slice(0, 10);
      if (day < range.from || day > range.to) continue; // Out of the requested range.

      const cell = byDay.get(day) ?? [];
      cell.push({
        id: item.id,
        title: item.title,
        state: this.stateOf(item, context),
        startAt: item.startAt ? item.startAt.toISOString() : null,
        dueAt: item.dueAt ? item.dueAt.toISOString() : null,
      });
      byDay.set(day, cell);
    }

    const days: WorkCalendarDay[] = [...byDay.keys()]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((date) => ({ date, items: (byDay.get(date) ?? []).sort(compareForCalendar) }));

    return { projectId, range, days };
  }

  /** The row's state as the domain union, failing closed on a corrupt row exactly as the view maps do. */
  private stateOf(row: WorkItemRow, context: TenantContext): WorkItemState {
    if (!isWorkItemState(row.state)) {
      logUnrecognisedRowState('work_item', row.id, context.correlationId);
      throw new Error(`work item ${row.id} has an unrecognised state`);
    }
    return row.state;
  }

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

  /**
   * Whether this principal may read a predecessor, judged against the predecessor's **own**
   * project and audience rather than the dependent item's — the redaction rule the health signal
   * uses (R01 / audit F3). A `false` means the caller has no relation to that predecessor's
   * project and its id must not appear on the timeline.
   */
  private mayReadPredecessor(
    context: TenantContext,
    principal: Principal,
    predecessor: PredecessorHealthRow,
  ): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: predecessor.projectId,
        audience: predecessor.audience,
        lifecycle: predecessor.state === 'archived' ? 'archived' : 'active',
      },
    }).allowed;
  }
}

/**
 * The timeline order: by `startAt`, then `dueAt`, then `id`, with a missing date sorting last
 * within its key. Comparing the ISO strings is safe — an ISO 8601 instant sorts lexicographically
 * in chronological order — and ids are compared as strings, which is their creation order.
 */
function compareForTimeline(left: WorkTimelineItem, right: WorkTimelineItem): number {
  const byStart = compareNullableIso(left.startAt, right.startAt);
  if (byStart !== 0) return byStart;
  const byDue = compareNullableIso(left.dueAt, right.dueAt);
  if (byDue !== 0) return byDue;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The order within a day cell: by `startAt`, then `dueAt`, then `id`, with a missing date
 * sorting last within its key — the same rule the timeline uses, so two items on the same day
 * read in a stable, meaningful order rather than the database's id order alone.
 */
function compareForCalendar(left: WorkCalendarItem, right: WorkCalendarItem): number {
  const byStart = compareNullableIso(left.startAt, right.startAt);
  if (byStart !== 0) return byStart;
  const byDue = compareNullableIso(left.dueAt, right.dueAt);
  if (byDue !== 0) return byDue;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A null date sorts after any real one; two nulls tie. */
function compareNullableIso(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}
