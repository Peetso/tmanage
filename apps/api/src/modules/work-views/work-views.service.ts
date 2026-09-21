import { authorize, isWorkItemState } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { logUnrecognisedRowState } from '../../common/observability/logger.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SavedViewConfig, SavedViewRow, WorkItemRow } from '../../common/database/schema.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkTimelineRepository } from './timeline.repository.js';
import { SavedViewsRepository } from './saved-views.repository.js';

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
 * WK-08's response projection (x107) — a saved Work view as a caller may see it. An explicit
 * projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7): `organization_id` is never
 * echoed, and a column added to `saved_views` in a future migration is invisible until someone
 * decides otherwise. Paired Exact with the web `SavedViewView` in `e2e/contracts/api-web-shapes.ts`
 * (CONTRACT-001).
 */
export interface SavedViewView {
  readonly id: string;
  /** Who owns (and may edit) the view. */
  readonly ownerUserId: string;
  /** `null` for an org-wide view; a project id for a project-scoped one. */
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The editable fields a create or a save carries. `ownerUserId` is the service's, never the body's. */
export interface SavedViewInput {
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
}

function toSavedViewView(row: SavedViewRow): SavedViewView {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    name: row.name,
    config: row.config,
    shared: row.shared,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class WorkViewsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly timeline: WorkTimelineRepository = new WorkTimelineRepository(),
    private readonly savedViews: SavedViewsRepository = new SavedViewsRepository(),
    /**
     * Read-only, and used for one thing: proving a project a saved view names exists **inside this
     * tenant** before the write is attempted, exactly as `MeetingsService.create` does. The
     * composite foreign key already refuses another tenant's project, but it surfaces as a 500; an
     * organization-wide caller skips the relation gate, so without this pre-resolution a missing or
     * cross-tenant `projectId` would fall through to that foreign key (the Known-trap of
     * FAST-PROTOCOL 19:55).
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Create a saved Work view owned by the acting user.
   *
   * The view is owned by the principal — `owner_user_id` is `context.userId`, never a body field —
   * which is the object-level authorization this slice needs: a person may always create their own
   * view. The route's `work.read` capability is the ceiling. When the view is project-scoped, the
   * named project is resolved tenant-scoped **first** (the Known-trap): an unknown or cross-tenant
   * project id is a 404 with no write, never the 500 the composite foreign key would otherwise
   * surface, and the caller must additionally be able to read that project.
   */
  async createSavedView(
    context: TenantContext,
    principal: Principal,
    input: SavedViewInput,
  ): Promise<SavedViewView> {
    await this.assertProjectVisible(context, principal, input.projectId);

    const row = await this.database.transaction(context, (tx) =>
      this.savedViews.create(tx, context, {
        ownerUserId: principal.userId,
        projectId: input.projectId,
        name: input.name,
        config: input.config,
        shared: input.shared,
      }),
    );

    return toSavedViewView(row);
  }

  /**
   * Replace the editable fields of a saved view the acting user owns.
   *
   * Order matters and follows the Known-trap: when the save names a project, that project is
   * resolved tenant-scoped **before** the ownership check, so an unknown or cross-tenant project
   * id is a 404 with no write rather than a 500. The view itself is then resolved tenant-scoped —
   * a missing one is a 404 — and the ownership rule is applied: only the owner may edit. A caller
   * who can *see* a shared view but does not own it is told `forbidden` (403); a private view they
   * do not own is a `not_found` (404), because its existence is not theirs to learn.
   */
  async updateSavedView(
    context: TenantContext,
    principal: Principal,
    savedViewId: string,
    input: SavedViewInput,
  ): Promise<SavedViewView> {
    await this.assertProjectVisible(context, principal, input.projectId);

    const existing = await this.database.read(context, (runner) =>
      this.savedViews.findById(runner, context, savedViewId),
    );
    if (!existing) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'saved_view_not_found');
    }

    if (existing.ownerUserId !== principal.userId) {
      if (existing.shared) {
        // Visible to the studio, so refusing the edit is an honest forbidden.
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'saved_view_not_owner');
      }
      // A private view the caller does not own must not even be revealed to exist.
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'saved_view_not_found');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.savedViews.update(tx, context, savedViewId, {
        projectId: input.projectId,
        name: input.name,
        config: input.config,
        shared: input.shared,
      }),
    );

    return toSavedViewView(row);
  }

  /**
   * The saved views this principal may see: their own, plus every view shared inside their studio,
   * in the repository's deterministic (name, then id) order. A pure read; the visibility rule is
   * the repository's `owner_user_id = ? OR shared` predicate and needs no per-row `authorize`,
   * because a shared view was shared org-wide by its owner and a private one is only ever the
   * caller's own.
   */
  async listSavedViews(context: TenantContext, principal: Principal): Promise<SavedViewView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.savedViews.listForViewer(runner, context, principal.userId),
    );
    return rows.map(toSavedViewView);
  }

  /**
   * Resolve a project a saved view names, tenant-scoped, before any write. A `null` project id is
   * an org-wide view and needs no resolution. An unknown or cross-tenant project id is a 404 (the
   * Known-trap: never the composite-FK 500); a project the caller cannot read is the same 404, so
   * a non-member can neither tell which projects exist nor which they are barred from.
   */
  private async assertProjectVisible(
    context: TenantContext,
    principal: Principal,
    projectId: string | null,
  ): Promise<void> {
    if (projectId === null) return;

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

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

/** A null date sorts after any real one; two nulls tie. */
function compareNullableIso(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}
