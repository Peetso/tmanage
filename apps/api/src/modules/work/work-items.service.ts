import { authorize, isWorkItemState, workItemStateMachine } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { logUnrecognisedRowState } from '../../common/observability/logger.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { ObjectiveWorkLinksRepository } from '../projects/objective-work-links.repository.js';
import { WorkItemFilesRepository } from './item-files.repository.js';
import { RatesRepository } from '../finance/rates.repository.js';
import { ensureWorkKey } from './work-keys.service.js';
import {
  effectivePageSize,
  MAX_PAGE_SIZE,
  WorkItemNotFoundError,
  WorkItemsRepository,
  WorkItemTransitionError,
  WorkItemVersionConflictError,
} from './work-items.repository.js';
import type {
  CreateWorkItemInput,
  ListWorkItemsOptions,
  UpdateWorkItemInput,
  WorkItemCompletion,
} from './work-items.repository.js';
import type { WorkBlockerRow, WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import {
  DependencyCycleError,
  DuplicateDependencyError,
  SelfDependencyError,
  WorkGraphRepository,
  WorkItemAlreadyBlockedError,
} from './work-graph.repository.js';
import type { PredecessorHealthRow } from './work-graph.repository.js';
import type { TypedDependencyInput } from './work-graph.repository.js';
import { findCycle } from '@tmanage/domain';

/**
 * WORK-001's application service — spec §3 steps 5 to 7 for the work aggregate.
 *
 * It is `ProjectsService`'s shape, and deliberately so: the repository stays free of policy,
 * the controller stays free of both, and everything in between happens here. What is different
 * is that a work item has two things a project does not, and each one costs a rule.
 *
 * ## 1. An audience, which is the whole of client isolation
 *
 * `work_items.audience` is `internal`, `client_visible` or `client_action_required`, and
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION` §7 makes it the control that decides what a client
 * may ever see. Two rules follow, and neither is optional:
 *
 * - **A client read never omits the audience filter.** `ListWorkItemsOptions.audiences` says
 *   in its own comment that omitting it returns every audience and "is only ever correct for
 *   an internal reader". {@link WorkItemsService.list} supplies the allowlist for a client
 *   principal before the query runs, so an internal item is not fetched and then discarded —
 *   it is never read.
 * - **`authorize()` checks it again on every row.** Belt and braces, and the braces are the
 *   important half: the filter is an optimisation of a rule, and the rule is `authorize()`.
 *
 * ## 2. A state machine, which is not this file's to reimplement
 *
 * `workItemStateMachine` is 35 tested cases in `packages/domain`, and it already knows which
 * transitions exist and which facts each one requires — a blocker reason to become blocked, a
 * resolution to leave it, an owner and a completion time to be done, a reason to reopen. This
 * service supplies the facts it was given and translates the machine's refusal into an HTTP
 * error. It does not decide anything about the lifecycle, because a second copy of that
 * knowledge is a second copy free to disagree.
 *
 * ## What "not found" means here
 *
 * A work item the principal has no relation to produces **404**, not 403, for the reason
 * `ProjectsService` gives and with more force: 403 confirms the row exists, and a client of an
 * agency must not be able to enumerate the agency's internal work by trying ids.
 */

/** What a caller is allowed to see of a work item. */
export interface WorkItemView {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly title: string;
  /**
   * A6 (0219). The plain-text description, `null` when none was written. Optional in the type
   * only so projections built elsewhere keep compiling; {@link toWorkItemView} always sets it.
   */
  readonly description?: string | null;
  readonly state: WorkItemState;
  readonly ownerUserId: string | null;
  readonly audience: Audience;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  /** When it was said to be completed on reaching `done`; `null` before that and after a reopen. */
  readonly completedAt: string | null;
  /** The concurrency token. A caller must present it to update or transition. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * An explicit projection, not a serialised row — `25-AUTH-AND-TENANT-ISOLATION` §7: "Never
 * implement client access as `serializeInternalObject(); delete fields`." `organization_id` is
 * absent: the caller already knows which organization they asked about.
 *
 * Exported for CHAT-003: converting a message creates a work item from inside the
 * conversations module, and a second projection there would be a copy free to drift.
 */
export function toWorkItemView(row: WorkItemRow, correlationId: string): WorkItemView {
  // The column is `VARCHAR(32)`, but only `workItemStateMachine` ever writes it. A value outside
  // the union means a corrupt row, which is a 500 — never a shape the response contract admits.
  // Fail closed, but log the row id + correlation id first (never the bad value) so the poisoned
  // row can be found; a single 500 otherwise names no row.
  if (!isWorkItemState(row.state)) {
    logUnrecognisedRowState('work_item', row.id, correlationId);
    throw new Error(`work item ${row.id} has an unrecognised state`);
  }
  const state = row.state;
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    title: row.title,
    description: row.description ?? null,
    state,
    ownerUserId: row.ownerUserId,
    audience: row.audience,
    startAt: row.startAt ? row.startAt.toISOString() : null,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    version: Number(row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

const toView = toWorkItemView;

/** 52-04: the work item's billable flag (`null` = inherit the project), read and written here. */
const billing = new RatesRepository();
const billableLabel = (value: boolean | null): string =>
  value === null ? 'inherit' : value ? 'billable' : 'non_billable';

// ── WORK-003's views ──────────────────────────────────────────────────────────

export interface WorkItemDependencyView {
  readonly id: string;
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** The ledger entry, whole: raised and — when it is — resolved. */
export interface WorkBlockerView {
  readonly id: string;
  readonly workItemId: string;
  readonly reason: string;
  readonly ask: string;
  readonly ownerUserId: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
  readonly resolvedByUserId: string | null;
}

function toBlockerView(row: WorkBlockerRow): WorkBlockerView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    reason: row.reason,
    ask: row.ask,
    ownerUserId: row.ownerUserId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolution: row.resolution,
    resolvedByUserId: row.resolvedByUserId,
  };
}

/** Every signal names its cause — UNIT-12's "explainable signals", as a closed union. */
export type WorkItemHealthSignal =
  | {
      readonly kind: 'blocked';
      readonly blockerId: string;
      readonly ask: string;
      readonly ownerUserId: string | null;
      readonly since: string;
    }
  | { readonly kind: 'predecessor_blocked'; readonly workItemId: string; readonly title: string }
  | {
      readonly kind: 'predecessor_late';
      readonly workItemId: string;
      readonly title: string;
      readonly dueAt: string;
    }
  /**
   * A predecessor the caller may not read is putting this item at risk. Nothing about the
   * blocking work is named — no id, no title, no due date — because a dependency can cross a
   * project boundary (linked by an org-wide admin, or read access revoked after the link),
   * and the caller has no relation to the predecessor's project. The caller still learns
   * their own item is at risk; whose work is holding it stays hidden. R01 / audit F3.
   */
  | { readonly kind: 'predecessor_redacted' };

export interface WorkItemHealthView {
  readonly status: 'blocked' | 'at_risk' | 'on_track';
  readonly signals: readonly WorkItemHealthSignal[];
  readonly computedAt: string;
}

/**
 * UNIT-12's project subject: the health of a whole project, rolled up over the per-item rule.
 *
 * `counts` tallies each readable item by the status {@link WorkItemsService.healthOf} would give
 * it, and `status` derives the project's own state by the same precedence a single item uses —
 * one `blocked` item makes the project `blocked`, one `at_risk` item (and none blocked) makes it
 * `at_risk`, otherwise `on_track`. It is computed, never stored: a read over the same rule, with
 * no new column, no write and no schedule.
 *
 * An empty project — one with no items the caller may read — is the documented empty value:
 * `itemCount` 0, every count 0, and `status` `on_track`, because nothing is blocked or at risk.
 * `itemCount` lets a consumer tell that apart from a project full of healthy work.
 */
export interface ProjectHealthView {
  readonly projectId: string;
  readonly status: 'blocked' | 'at_risk' | 'on_track';
  readonly counts: {
    readonly on_track: number;
    readonly at_risk: number;
    readonly blocked: number;
  };
  readonly itemCount: number;
  readonly computedAt: string;
}

/**
 * The audiences a client principal may read.
 *
 * `internal` is absent, and that absence is the control. `12-PERMISSION-MATRIX` §2 and the
 * isolation spec §7 both say a client sees published work and their own actions; an internal
 * item is not a narrower view of the same row, it is a row they must not know exists.
 */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

/**
 * How far ahead of the server's clock a `completedAt` may sit and still be "now". Five
 * minutes covers a browser whose clock runs a little fast; it does not cover a completion
 * dated tomorrow.
 */
const COMPLETION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How many SQL pages one `list` call may walk while filling a page of readable rows. At the
 * largest page size that is 5,000 rows examined per request — far past any tenant this
 * deployment profile serves, and a hard stop on a principal who can read almost nothing.
 */
const LIST_PAGE_BUDGET = 25;

/**
 * CQ-07 (WRK-07): the lifecycle states in plain words, for the refusal a person reads. The
 * stored values are machine tokens (`internal_review`), and a refusal that quotes them reads as
 * a leak of the schema rather than an instruction. The web has its own `stateLabel`; this is the
 * API's copy for the one place the refusal sentence is built, so an API-only caller is told the
 * same plain thing.
 */
const WORK_ITEM_STATE_LABELS: Record<WorkItemState, string> = {
  backlog: 'backlog',
  ready: 'ready',
  in_progress: 'in progress',
  blocked: 'blocked',
  internal_review: 'internal review',
  done: 'done',
  archived: 'archived',
};

function stateLabel(state: WorkItemState): string {
  return WORK_ITEM_STATE_LABELS[state] ?? state.replace(/_/g, ' ');
}

/**
 * CQ-07 (WRK-07): a field-specific message for each fact a transition can require, so the refusal
 * names what is missing in plain words rather than repeating a generic "is required". The web
 * leads each line with its own human label for the field; this message completes it, and stands
 * on its own for an API-only caller. An unrecognised fact falls back to the generic phrase.
 */
const TRANSITION_FACT_MESSAGES: Record<string, string> = {
  ownerId: 'name who owned it to completion',
  completedAt: 'give the date it was completed',
  blockerReason: 'give the reason it is blocked',
  blockerAsk: 'say what you need, and from whom',
  blockerResolution: 'say how the block was resolved',
  reopenReason: 'give the reason for reopening it',
};

function transitionFactMessage(fact: string): string {
  return TRANSITION_FACT_MESSAGES[fact] ?? 'is required for this transition';
}

export class WorkItemsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    /** Optional for the reason `ProjectsService`'s is: a test can assert what is written. */
    private readonly audit?: AuditService,
    /**
     * Read-only, and used for exactly one thing: proving the project a new work item names
     * exists **inside this tenant** before the insert is attempted.
     *
     * `fk_work_items_project_tenant` already refuses a project from another organization, so
     * nothing crosses the boundary either way — but a foreign key violation surfaces as a
     * 500, and the first run of this ticket's suite showed exactly that. A caller who names
     * another tenant's project id should get the same 404 as one who names an id that does
     * not exist, which is the answer every other "no relation to this" produces.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * PLAT-004. Optional for the reason `audit` is — a test can construct the service
     * without one and assert nothing was written. The running application always wires it.
     */
    private readonly outbox?: OutboxEventsRepository,
    /** WORK-003: the edges and the blocker ledger. Stateless, so a default is safe. */
    private readonly graph: WorkGraphRepository = new WorkGraphRepository(),
    /**
     * CQ-07 (WRK-14): read-only, and used for exactly one thing — proving a project has a client
     * linked before a work item may be moved into the `client_action_required` audience. Stateless,
     * so a default is safe, and appended last so existing call sites keep working.
     */
    private readonly projectClients: ProjectClientsRepository = new ProjectClientsRepository(),
    /**
     * A6: read-only, used for one thing — when an item moves to another project, whether its
     * owner is on that project. Stateless, so a default is safe, and appended last.
     */
    private readonly projectMemberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    /**
     * F24: objective edges are project-scoped, so a move removes the item's objective links in the
     * same transaction. Stateless, so a default is safe, and appended last.
     */
    private readonly objectiveLinks: ObjectiveWorkLinksRepository = new ObjectiveWorkLinksRepository(),
    /**
     * F50: a move detaches attachments whose file stays in the source project, in the same
     * transaction. Stateless, so a default is safe, and appended last.
     */
    private readonly itemFiles: WorkItemFilesRepository = new WorkItemFilesRepository(),
  ) {}

  /**
   * List the work this principal may read.
   *
   * The audience allowlist is applied **before** the query for a client principal, so an
   * internal item never leaves the database. The relation check then runs per row, because
   * `authorize()` is the one place that rule is written.
   *
   * ## A page is `limit` *readable* rows, not `limit` rows minus the unreadable ones
   *
   * The relation check cannot be pushed into SQL — it is `authorize()`'s rule, not a column —
   * so it runs after the query, and a page of `limit` rows can come back with fewer than
   * `limit` readable ones. Until 2026-09-01 that trimmed page was returned as the page: a
   * member on one project in a tenant with many would see a list that ended early, and both
   * web screens read "fewer than `limit`" as "that is all there is". Now the query is asked
   * for the next page, from the last row seen, until either `limit` readable rows are in hand
   * or the database returns a short page. The cursor the caller gets back — the last returned
   * row's id — stays valid: every row skipped sorts before it and every row not yet fetched
   * sorts after.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListWorkItemsOptions = {},
  ): Promise<readonly WorkItemView[]> {
    const scoped: ListWorkItemsOptions =
      principal.kind === 'client' ? { ...options, audiences: CLIENT_AUDIENCES } : options;
    const limit = effectivePageSize(options.limit);

    const readable = await this.database.read(context, async (runner) => {
      const collected: WorkItemRow[] = [];
      let after = scoped.after;
      // The walk is bounded, because it holds one pooled connection for its whole length and
      // a principal who may read almost nothing in a very large tenant would otherwise turn
      // one request into a scan of the table. Past the budget the page is returned short;
      // the cursor is still valid, so a caller that pages on simply asks again. The web
      // screens read a short page as "that is all", which past this many consecutive
      // unreadable rows is wrong — recorded in implementation-status as the narrowing.
      for (let pages = 0; pages < LIST_PAGE_BUDGET; pages += 1) {
        const page = await this.workItems.list(runner, context, {
          ...scoped,
          ...(after === undefined ? {} : { after }),
          limit,
        });
        for (const row of page) {
          if (this.mayRead(principal, row)) collected.push(row);
        }
        const last = page[page.length - 1];
        if (page.length < limit || collected.length >= limit || last === undefined) break;
        after = last.id;
      }
      return collected.slice(0, limit);
    });

    return readable.map((row) => toView(row, context.correlationId));
  }

  /** Read one work item. Absent, deleted, or unrelated all produce the same 404. */
  async get(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemView> {
    const row = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, workItemId),
    );

    // A soft-deleted item reads as absent. `list` already excludes it, and a `get` that
    // still returned it would make "deleted" mean two different things depending on how the
    // row was reached.
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return toView(row, context.correlationId);
  }

  /**
   * Read several work items at once, keyed by id — `get`'s authorized read, in one query
   * rather than one per id.
   *
   * An id that is absent, deleted, or not this principal's to see is **missing from the map**,
   * which is `get`'s 404 said without a throw: the caller that needs this is the inbox, which
   * drops a bundle silently in every one of those cases and must not learn which one it was.
   * Nothing is answered here that `get` would refuse, because the two apply the same
   * expressions to the same row — the test that proves it reads an item both ways.
   */
  async getMany(
    context: TenantContext,
    principal: Principal,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkItemView>> {
    const unique = [...new Set(workItemIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.database.read(context, (runner) =>
      this.workItems.findManyByIds(runner, context, unique),
    );

    const views = new Map<string, WorkItemView>();
    for (const row of rows) {
      if (row.deletedAt !== null || !this.mayRead(principal, row)) continue;
      views.set(row.id, toView(row, context.correlationId));
    }
    return views;
  }

  /**
   * Create a work item.
   *
   * The project relation is checked here rather than left to the database, and that is the one
   * place this service is stricter than its neighbours. `fk_work_items_project_tenant` refuses
   * a project from another *organization*, which is the tenant boundary — but it says nothing
   * about whether this principal is related to that project inside their own organization. A
   * member without organization-wide scope must not be able to file work into a project they
   * are not on.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateWorkItemInput,
  ): Promise<WorkItemView> {
    // Two checks, and they answer different questions. The first: does this project exist in
    // this tenant at all? The second: may this principal act on it? Both refuse with 404,
    // because distinguishing them would tell a caller which project ids are real.
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    this.requireProjectRelation(principal, context, input.projectId, 'work.create');
    // F26: creating an item straight into a client audience publishes it to the portal.
    if (input.audience !== undefined && input.audience !== 'internal') {
      this.requirePublish(principal, context, input.projectId);
    }
    if (input.ownerUserId) await this.requireOwnerIsMember(context, input.ownerUserId);

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.workItems.create(tx, context, input);
      // R16-e (54-10): the item's work key (`TM-482`) when its project has a prefix; no-op otherwise.
      await ensureWorkKey(tx, context, created.id);

      await this.audit?.record(tx, context, {
        action: 'work_item.created',
        objectId: created.id,
        result: 'allowed',
        metadata: {
          project_id: created.projectId,
          work_item_type: created.type,
          audience: created.audience,
          state: created.state,
        },
      });

      // CQ-12 (AUT-01): the `work_item_created` automation trigger. Ids and the state only.
      await this.outbox?.append(tx, context, {
        type: 'work_item.created.v1',
        aggregateId: created.id,
        payload: { workItemId: created.id, projectId: created.projectId, state: created.state },
      });

      return created;
    });

    return toView(row, context.correlationId);
  }

  /**
   * Change a work item's fields. Never its state — that is {@link transition}.
   *
   * Not audited. `12-PERMISSION-MATRIX` §12 lists the changes that are security events —
   * roles, permissions, exports, publication, credentials — and retitling a task is none of
   * them. Auditing every field edit would bury the rows that matter in rows that do not, and
   * the row already carries `updated_at` and a version.
   *
   * **Changing the audience is the exception**, and it is audited, because widening a work
   * item to `client_visible` is a publication decision.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    expectedVersion: number,
    requested: UpdateWorkItemInput & {
      /** 52-04: `true` / `false`, or `null` to inherit the project's `billable_default`. */
      readonly billable?: boolean | null;
    },
  ): Promise<WorkItemView & { readonly billable?: boolean | null }> {
    const before = await this.readForWrite(context, principal, workItemId, 'work.update');
    if (requested.ownerUserId) await this.requireOwnerIsMember(context, requested.ownerUserId);
    const input = await this.resolveMove(context, principal, before, requested);
    const targetProjectId = input.projectId ?? before.projectId;
    const moving = input.projectId !== undefined && input.projectId !== before.projectId;

    // F26: widening to a client audience is a publish-to-client decision, and so is carrying a
    // client-audience item into another project (whose clients have never seen it). Either needs
    // `deliverable.publish` on the target project — the capability the sibling publish paths
    // (document audience, deliverable send) already require. Guests never hold it.
    const audienceAfter = input.audience ?? before.audience;
    if (audienceAfter !== 'internal' && (audienceAfter !== before.audience || moving)) {
      this.requirePublish(principal, context, targetProjectId);
    }

    // CQ-07 (WRK-14): "client action needed" is a request to a client, and the worker emails the
    // client people who can act on it. On a project with no client linked that request reaches
    // nobody, so refuse the move rather than set an audience that promises a reader who cannot
    // exist. Checked before the transaction opens; `client_visible` and `internal` are unaffected.
    if (input.audience === 'client_action_required') {
      const linked = await this.database.read(context, (runner) =>
        this.projectClients.list(runner, context, { projectId: targetProjectId, limit: 1 }),
      );
      if (linked.length === 0) {
        throw new ApiError(
          422,
          'validation_failed',
          'This project has no client linked, so a client cannot be asked to act on its work',
          [{ field: 'audience', message: 'link a client to this project first' }],
        );
      }
    }

    const widening =
      input.audience !== undefined &&
      input.audience !== before.audience &&
      input.audience !== 'internal';

    const row = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const updated = await this.workItems.update(
          tx,
          context,
          workItemId,
          expectedVersion,
          input,
        );

        if (moving) {
          // F24 + F50: edges scoped to the source project do not travel with the item. Objective
          // links are removed, and attachments whose file stays in the source project are detached,
          // so neither list keeps disclosing the other project's titles or file names.
          await this.objectiveLinks.deleteForWorkItem(tx, context, workItemId);
          await this.itemFiles.detachOutsideProject(tx, context, workItemId, targetProjectId);
        }

        if (input.audience !== undefined && input.audience !== before.audience) {
          await this.audit?.record(tx, context, {
            action: 'work_item.audience_changed',
            objectId: updated.id,
            result: 'allowed',
            metadata: {
              project_id: updated.projectId,
              audience_before: before.audience,
              audience_after: updated.audience,
              widened: widening,
            },
          });
        }

        // 52-04: billable (or inherit) — `work.update`, audited, so a member hiding their own
        // hours as non-billable leaves a trail.
        if (requested.billable !== undefined) {
          const was = await billing.workItemBillable(tx, context.organizationId, updated.id);
          await billing.setWorkItemBillable(
            tx,
            context.organizationId,
            updated.id,
            requested.billable,
          );
          if (was !== requested.billable) {
            await this.audit?.record(tx, context, {
              action: 'work_item.billable_changed',
              objectId: updated.id,
              result: 'allowed',
              metadata: {
                project_id: updated.projectId,
                billable_before: billableLabel(was),
                billable_after: billableLabel(requested.billable),
              },
            });
          }
        }

        // CQ-12 (APR-03): "client action needed" is a request to the client; the worker emails
        // the client people who can act on it. Only on the move into that audience.
        if (
          input.audience === 'client_action_required' &&
          before.audience !== 'client_action_required'
        ) {
          await this.outbox?.append(tx, context, {
            type: 'work_item.client_action_requested.v1',
            aggregateId: updated.id,
            payload: { workItemId: updated.id, projectId: updated.projectId },
          });
        }

        return updated;
      }),
    );

    const view = toView(row, context.correlationId);
    return requested.billable === undefined ? view : { ...view, billable: requested.billable };
  }

  /**
   * Move a work item through the lifecycle.
   *
   * Every transition is audited, and that is not the same judgement as `update`'s. A state
   * change is what the work *means* — started, blocked, reviewed, done, reopened — and §5's
   * requirements exist precisely because those moments have to be defensible later. "Who
   * marked this done, and when" is the question a client asks when a deliverable is wrong.
   *
   * The machine decides what is legal and what each transition requires. A refusal becomes a
   * 422 naming the facts that were missing, which is safe to be specific about: the caller
   * already holds the row, so nothing is disclosed by telling them a blocker needs a reason.
   */
  async transition(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    expectedVersion: number,
    to: WorkItemState,
    facts: Readonly<Record<string, unknown>> = {},
  ): Promise<WorkItemView> {
    const before = await this.readForWrite(context, principal, workItemId, 'work.transition');

    // WORK-003: entering `blocked` persists the blocker (US-B04 — reason, ask, optional
    // owner, since date), so the machine's required facts stop being prose that vanishes
    // into an audit key list. The optional owner is validated before the transaction
    // opens: an ask on somebody who cannot act in this organization is an ask on nobody.
    const blockerFacts = to === 'blocked' ? this.blockerFactsOf(facts) : undefined;
    if (blockerFacts?.ownerUserId) {
      const isMember = await this.database.read(context, (runner) =>
        this.graph.isActiveInternalMember(runner, context, blockerFacts.ownerUserId as string),
      );
      if (!isMember) {
        throw new ApiError(422, 'validation_failed', 'The blocker owner is not a member', [
          { field: 'blockerOwnerUserId', message: 'must be an active member of this organization' },
        ]);
      }
    }

    // 0013: reaching `done` writes the two facts §5 requires for it. They are parsed and the
    // owner's membership is checked before the transaction opens, for the reason the blocker
    // owner's is — and only when both facts are present, so that a request missing one is
    // still refused by the machine, naming what was missing, rather than by a parser naming
    // the shape of a fact it never got. And only when the move is one the machine has at
    // all: `backlog -> done` must be refused as illegal, not as "the owner is not a member",
    // and the membership read must not run for a move that was never going to happen.
    const completion =
      to === 'done' &&
      workItemStateMachine.allowedFrom(before.state as WorkItemState).includes('done')
        ? await this.completionFactsOf(context, facts)
        : undefined;

    try {
      const row = await this.writing(() =>
        this.database.transaction(context, async (tx) => {
          const moved = await this.workItems.transitionState(
            tx,
            context,
            workItemId,
            expectedVersion,
            to,
            facts,
            completion,
          );

          await this.audit?.record(tx, context, {
            action: 'work_item.transitioned',
            objectId: moved.id,
            result: 'allowed',
            metadata: {
              project_id: moved.projectId,
              state_before: before.state,
              state_after: moved.state,
              // Which facts were supplied, never their content. A blocker reason is prose
              // written by a person, and §12's metadata rule is identifiers and
              // classifications — see `isSafeAuditMetadata`.
              //
              // An **array**, not a joined string. `VALUE_PATTERN` forbids a comma, which is
              // the separator a joined list needs; the metadata contract already carries arrays
              // of scalars, so the list travels as a list. The first run of
              // `work-001-work-items.db.test.ts` failed on exactly this — every transition
              // carrying facts became a 500 at the write boundary, which is the boundary doing
              // its job on its own author.
              facts_supplied: Object.keys(facts).sort(),
            },
          });

          // 24-EVENT-CATALOG §4 `work_item.updated.v1`, in the same transaction as the
          // state change and the audit row — §2's "producer writes state and outbox event
          // atomically". Ids and states only; the facts stay on the row. Field edits do not
          // emit this event today — the narrowing is recorded in implementation-status.
          await this.outbox?.append(tx, context, {
            type: 'work_item.updated.v1',
            aggregateId: moved.id,
            payload: {
              workItemId: moved.id,
              projectId: moved.projectId,
              fromState: before.state,
              toState: moved.state,
              workItemVersion: Number(moved.version),
            },
          });

          // WORK-003, both directions of the `blocked` boundary, in the same transaction
          // as the transition that crosses it.
          if (blockerFacts) {
            const blocker = await this.graph.raiseBlocker(tx, context, {
              workItemId: moved.id,
              reason: blockerFacts.reason,
              ask: blockerFacts.ask,
              ownerUserId: blockerFacts.ownerUserId,
            });
            // §4 "blocker activated — health, inbox, notification". Ids only.
            await this.outbox?.append(tx, context, {
              type: 'work_item.blocked.v1',
              aggregateId: moved.id,
              payload: {
                workItemId: moved.id,
                projectId: moved.projectId,
                blockerId: blocker.id,
                ownerUserId: blocker.ownerUserId,
              },
            });
          }
          if (before.state === 'blocked' && to !== 'blocked') {
            // The machine required `blockerResolution` to leave; record it on the ledger.
            // A null answer means the blocker predates 0011 — nothing to resolve is not
            // an error, and inventing a row to resolve would falsify the history.
            await this.graph.resolveActiveBlocker(
              tx,
              context,
              moved.id,
              this.boundedFact(facts, 'blockerResolution'),
            );
          }

          return moved;
        }),
      );

      return toView(row, context.correlationId);
    } catch (error) {
      if (error instanceof WorkItemTransitionError) {
        // CQ-07 (WRK-07): plain state names in the sentence, and a field-specific message per
        // missing fact, so the refusal says which field is missing in plain words rather than
        // quoting the schema's tokens.
        throw new ApiError(
          422,
          'validation_failed',
          `This item cannot move from ${stateLabel(error.from)} to ${stateLabel(error.to)} yet`,
          error.missing.map((fact) => ({
            field: fact,
            message: transitionFactMessage(fact),
          })),
          error.reason,
        );
      }
      if (error instanceof WorkItemAlreadyBlockedError) {
        // Reachable only when the row's state and its ledger disagree — refusing loudly
        // beats writing a second "active" truth.
        throw new ApiError(409, 'conflict', 'This work item already has an active blocker');
      }
      throw error;
    }
  }

  // ── WORK-003: dependencies, the blocker ledger, and the health signal ───────

  /**
   * Add an edge: this item depends on another. Both ends must be readable by this
   * principal — a dependency on a row someone may not see would leak its existence through
   * every health answer — and the edge must be acyclic.
   *
   * 53-04: the edge is typed (`kind`, `lag`, `source`, defaults FS / 0 / ui) and audited. Inside
   * the transaction the project rows of both ends are locked first (ascending id), then the
   * active edges downstream of this item are read and `findCycle` runs — two concurrent inserts
   * on the same projects serialise, so no loop can form between them. A cycle is a 409 naming
   * the loop by the titles the caller can read; any other item in it is "hidden". Rate limit:
   * the durable limiter keys by ip/link/token, not by user, so the 60/min/user budget is left to
   * the global throttle until a user-keyed helper exists.
   */
  async addDependency(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dependsOnWorkItemId: string,
    typed: TypedDependencyInput = { kind: 'FS', lag: 0, source: 'ui' },
  ): Promise<
    WorkItemDependencyView & {
      readonly kind: string;
      readonly lagWorkingDays: number;
      readonly createdSource: string;
      readonly status: string;
    }
  > {
    const dependent = await this.readForWrite(context, principal, workItemId, 'work.update');
    // The predecessor needs only readability: depending on work is not editing it.
    const predecessor = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, dependsOnWorkItemId),
    );
    if (!predecessor || predecessor.deletedAt !== null || !this.mayRead(principal, predecessor)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    try {
      const row = await this.database.transaction(context, async (tx) => {
        await this.graph.lockProjects(tx, context, [dependent.projectId, predecessor.projectId]);
        const edges = await this.graph.listActiveEdgesFrom(tx, context, workItemId);
        const loop = findCycle(edges, { workItemId, dependsOnWorkItemId });
        if (loop !== null && workItemId !== dependsOnWorkItemId) {
          throw new DependencyCycleError(workItemId, dependsOnWorkItemId, loop);
        }
        const added = await this.graph.addDependency(
          tx,
          context,
          workItemId,
          dependsOnWorkItemId,
          typed,
        );
        await this.audit?.record(tx, context, {
          action: 'work_item.dependency_added',
          objectId: workItemId,
          result: 'allowed',
          metadata: {
            depended_on_id: dependsOnWorkItemId,
            dependency_id: added.id,
            kind: typed.kind,
            lag_working_days: typed.lag,
            source: typed.source,
          },
        });
        return added;
      });
      return {
        id: row.id,
        workItemId: row.workItemId,
        dependsOnWorkItemId: row.dependsOnWorkItemId,
        kind: row.kind,
        lagWorkingDays: Number(row.lagWorkingDays),
        createdSource: row.createdSource,
        status: row.status,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof SelfDependencyError) {
        throw new ApiError(422, 'validation_failed', error.message, [
          { field: 'dependsOnWorkItemId', message: 'must be a different work item' },
        ]);
      }
      if (error instanceof DependencyCycleError) {
        const rows = await this.database.read(context, (runner) =>
          this.workItems.findManyByIds(runner, context, error.path),
        );
        const titles = error.path.map((id) => {
          const found = rows.find((r) => r.id === id);
          return found && found.deletedAt === null && this.mayRead(principal, found)
            ? found.title
            : 'hidden';
        });
        throw new ApiError(
          409,
          'conflict',
          'That dependency would create a cycle',
          [{ field: 'dependsOnWorkItemId', message: `dependency_cycle: ${titles.join(' → ')}` }],
          'dependency_cycle',
        );
      }
      if (error instanceof DuplicateDependencyError) {
        throw new ApiError(409, 'conflict', error.message);
      }
      throw error;
    }
  }

  /**
   * Remove an edge. Audited — the delete destroys the only record of the edge, and an
   * edge quietly removed is a health claim quietly changed.
   */
  async removeDependency(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dependencyId: string,
  ): Promise<void> {
    await this.readForWrite(context, principal, workItemId, 'work.update');

    await this.database.transaction(context, async (tx) => {
      const removed = await this.graph.removeDependency(tx, context, workItemId, dependencyId);
      if (!removed) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      await this.audit?.record(tx, context, {
        action: 'work_item.dependency_removed',
        objectId: workItemId,
        result: 'allowed',
        metadata: {
          depended_on_id: removed.dependsOnWorkItemId,
          dependency_id: removed.id,
        },
      });
    });
  }

  /** The item's blocker ledger, oldest first — US-B04's history, raised and resolved. */
  async listBlockers(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkBlockerView[]> {
    await this.get(context, principal, workItemId); // The same 404 rules as any read.
    const rows = await this.database.read(context, (runner) =>
      this.graph.listBlockers(runner, context, workItemId),
    );
    return rows.map(toBlockerView);
  }

  /**
   * The health signal — WORK-003's third word, `09-MVP-PRD` §63's rule made a read.
   *
   * Computed, never stored: a stored status is a cache of an opinion, free to go stale the
   * moment a predecessor's due date moves. Every signal names its cause — UNIT-12's
   * "explainable signals" — and the answer carries `computedAt` so a consumer knows how
   * fresh the claim is. §63's manager override ("record override rationale") has no
   * storage and is a named gap, so today a late predecessor always costs the claim.
   */
  async healthOf(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemHealthView> {
    await this.get(context, principal, workItemId); // 404 before anything is revealed.

    const { blocker, predecessors } = await this.database.read(context, async (runner) => ({
      blocker: await this.graph.findActiveBlocker(runner, context, workItemId),
      predecessors: await this.graph.listPredecessors(runner, context, workItemId),
    }));

    return this.deriveHealth(context, principal, blocker, predecessors, new Date());
  }

  /**
   * UNIT-12's project subject: roll per-item health up across a project (`09-MVP-PRD` §63).
   *
   * A pure read over the same rule {@link healthOf} applies to one item — no new column, no
   * write, no schedule. It is exposed behind `work.read`, the sibling reads' capability; a
   * caller without it is refused by the same guard, so the roll-up is never a way around it.
   *
   * The walk is `list`'s: the tenant-scoped, project-filtered query returns rows in id order,
   * each row is kept only if `mayRead` allows it — a cross-tenant row is refused there as well
   * as by the query, and a client sees only client-audience items — and every readable item's
   * status is computed by {@link deriveHealth}, the very code path `healthOf` uses, so the
   * roll-up cannot drift from the per-item answer. Every project item is visited, page by page,
   * because a count that stops early is a wrong count, not a short one.
   */
  async projectHealthOf(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectHealthView> {
    const scoped: ListWorkItemsOptions =
      principal.kind === 'client' ? { projectId, audiences: CLIENT_AUDIENCES } : { projectId };

    const now = new Date();
    const counts = { on_track: 0, at_risk: 0, blocked: 0 };

    await this.database.read(context, async (runner) => {
      let after: string | undefined;
      for (;;) {
        const page = await this.workItems.list(runner, context, {
          ...scoped,
          ...(after === undefined ? {} : { after }),
          limit: MAX_PAGE_SIZE,
        });

        // Batch the two graph reads across the readable rows of this page, so the walk issues a
        // bounded number of queries (two per page) rather than two per item (review-x86 F3). The
        // per-item rule below is unchanged: each row is scored by the same `deriveHealth`.
        const readable = page.filter((row) => this.mayRead(principal, row));
        const ids = readable.map((row) => row.id);
        const blockers = await this.graph.findActiveBlockersByItem(runner, context, ids);
        const predecessorsByItem = await this.graph.listPredecessorsByItem(runner, context, ids);

        for (const row of readable) {
          const blocker = blockers.get(row.id) ?? null;
          const predecessors = predecessorsByItem.get(row.id) ?? [];
          const { status } = this.deriveHealth(context, principal, blocker, predecessors, now);
          counts[status] += 1;
        }

        const last = page[page.length - 1];
        if (page.length < MAX_PAGE_SIZE || last === undefined) break;
        after = last.id;
      }
    });

    const itemCount = counts.on_track + counts.at_risk + counts.blocked;
    const status = counts.blocked > 0 ? 'blocked' : counts.at_risk > 0 ? 'at_risk' : 'on_track';
    return { projectId, status, counts, itemCount, computedAt: now.toISOString() };
  }

  /**
   * The per-item health rule — `09-MVP-PRD` §63 made a read — in one place, so that the single
   * read ({@link healthOf}) and the project roll-up ({@link projectHealthOf}) share it rather
   * than keep two copies that can disagree. A blocker makes the item `blocked`; a non-landed
   * predecessor that is blocked or late makes it `at_risk` (named, or redacted when the caller
   * may not read the predecessor — R01 / audit F3); otherwise `on_track`.
   */
  private deriveHealth(
    context: TenantContext,
    principal: Principal,
    blocker: WorkBlockerRow | null,
    predecessors: readonly PredecessorHealthRow[],
    now: Date,
  ): WorkItemHealthView {
    const signals: WorkItemHealthSignal[] = [];

    if (blocker) {
      signals.push({
        kind: 'blocked',
        blockerId: blocker.id,
        ask: blocker.ask,
        ownerUserId: blocker.ownerUserId,
        since: blocker.createdAt.toISOString(),
      });
    }

    for (const predecessor of predecessors) {
      if (predecessor.deletedAt !== null) continue;
      const landed = predecessor.state === 'done' || predecessor.state === 'archived';
      if (landed) continue;

      const isBlocked = predecessor.state === 'blocked';
      const isLate = predecessor.dueAt !== null && predecessor.dueAt < now;
      if (!isBlocked && !isLate) continue;

      // A predecessor can live in a project the caller has no relation to — linked across
      // projects by an org-wide admin, or the caller's access revoked after the edge was
      // made. Authorize each one against its *own* project and audience before disclosing
      // its title, id or due date. When the caller may not read it, surface the risk as a
      // redacted signal that names nothing about the blocking work. R01 / audit F3.
      if (!this.mayReadPredecessor(context, principal, predecessor)) {
        signals.push({ kind: 'predecessor_redacted' });
        continue;
      }

      if (isBlocked) {
        signals.push({
          kind: 'predecessor_blocked',
          workItemId: predecessor.workItemId,
          title: predecessor.title,
        });
      } else if (predecessor.dueAt !== null) {
        signals.push({
          kind: 'predecessor_late',
          workItemId: predecessor.workItemId,
          title: predecessor.title,
          dueAt: predecessor.dueAt.toISOString(),
        });
      }
    }

    const status = blocker ? 'blocked' : signals.length > 0 ? 'at_risk' : 'on_track';
    return { status, signals, computedAt: now.toISOString() };
  }

  /** US-B04's facts, shaped and bounded before anything is written. */
  private blockerFactsOf(facts: Readonly<Record<string, unknown>>): {
    readonly reason: string;
    readonly ask: string;
    readonly ownerUserId: string | null;
  } {
    const reason = this.boundedFact(facts, 'blockerReason');
    const ask = this.boundedFact(facts, 'blockerAsk');
    const owner = facts['blockerOwnerUserId'];
    if (owner !== undefined && owner !== null && typeof owner !== 'string') {
      throw new ApiError(422, 'validation_failed', 'The blocker owner is not an id', [
        { field: 'blockerOwnerUserId', message: 'must be a user id' },
      ]);
    }
    // A blank owner is no owner. Left untrimmed, `''` slipped past the membership check
    // (falsy) and reached the `users` foreign key as a 500 — found by the 2026-09-01 fleet.
    const ownerUserId = typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null;
    return { reason, ask, ownerUserId };
  }

  /**
   * §5's two facts for `done`, as the columns they become (0013).
   *
   * Returns `undefined` when either fact is absent or blank, leaving the refusal to the
   * machine so that the 422 names the *missing* fact rather than a malformed one. When both
   * are present they are judged: the owner must be an active internal member of this
   * organization — an item completed by nobody who can act here is not completed — and the
   * completion time must be an instant that has happened. A small allowance for clock skew is
   * made; a completion dated next week is refused, because the row would then claim a thing
   * that is not yet true.
   */
  private async completionFactsOf(
    context: TenantContext,
    facts: Readonly<Record<string, unknown>>,
  ): Promise<WorkItemCompletion | undefined> {
    const owner = facts['ownerId'];
    const completed = facts['completedAt'];
    const ownerBlank =
      owner === undefined || owner === null || (typeof owner === 'string' && owner.trim() === '');
    const completedBlank =
      completed === undefined ||
      completed === null ||
      (typeof completed === 'string' && completed.trim() === '');
    if (ownerBlank || completedBlank) return undefined;

    const details: { field: string; message: string }[] = [];
    if (typeof owner !== 'string') {
      details.push({ field: 'ownerId', message: 'must be a user id' });
    }
    const completedAt = typeof completed === 'string' ? new Date(completed) : new Date(NaN);
    if (typeof completed !== 'string' || Number.isNaN(completedAt.getTime())) {
      details.push({ field: 'completedAt', message: 'must be an ISO 8601 instant' });
    } else if (completedAt.getTime() > Date.now() + COMPLETION_CLOCK_SKEW_MS) {
      details.push({ field: 'completedAt', message: 'must not be in the future' });
    }
    if (details.length > 0) {
      throw new ApiError(422, 'validation_failed', 'The completion facts are not usable', details);
    }

    const ownerUserId = (owner as string).trim();
    const isMember = await this.database.read(context, (runner) =>
      this.graph.isActiveInternalMember(runner, context, ownerUserId),
    );
    if (!isMember) {
      throw new ApiError(422, 'validation_failed', 'The owner is not a member', [
        { field: 'ownerId', message: 'must be an active member of this organization' },
      ]);
    }

    return { ownerUserId, completedAt };
  }

  /**
   * An owner set on create or edit must be an active member of this organization — the rule
   * `done` already applies to its `ownerId` fact. `owner_user_id` references the global users
   * table, so without this a hand-made request could put another tenant's person, or a client
   * person, on this tenant's row (T2c proof: work-011).
   */
  private async requireOwnerIsMember(context: TenantContext, ownerUserId: string): Promise<void> {
    const isMember = await this.database.read(context, (runner) =>
      this.graph.isActiveInternalMember(runner, context, ownerUserId),
    );
    if (!isMember) {
      throw new ApiError(422, 'validation_failed', 'The owner is not a member', [
        { field: 'ownerUserId', message: 'must be an active member of this organization' },
      ]);
    }
  }

  /**
   * A6: a move to another project. The target must exist in this tenant, not be archived, and
   * be one this principal may file work into — every refusal the same 404 `create` gives, so a
   * caller cannot learn which project ids are real. The owner stays only when they are on the
   * target project; otherwise the moved item arrives unassigned rather than owned by someone
   * who cannot see it there. A "move" to the project the item is already in is dropped.
   */
  private async resolveMove(
    context: TenantContext,
    principal: Principal,
    before: WorkItemRow,
    input: UpdateWorkItemInput,
  ): Promise<UpdateWorkItemInput> {
    if (input.projectId === undefined) return input;
    if (input.projectId === before.projectId) {
      const rest: { -readonly [K in keyof UpdateWorkItemInput]: UpdateWorkItemInput[K] } = {
        ...input,
      };
      delete rest.projectId;
      return rest;
    }
    const targetProjectId = input.projectId;
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, targetProjectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    this.requireProjectRelation(principal, context, targetProjectId, 'work.create');

    const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : before.ownerUserId;
    if (ownerUserId === null) return input;
    const onTarget = await this.database.read(context, (runner) =>
      this.projectMemberships.findByProjectAndUser(runner, context, targetProjectId, ownerUserId),
    );
    return onTarget ? input : { ...input, ownerUserId: null };
  }

  /** A fact column is VARCHAR(1000); refuse an essay before the driver truncates one. */
  private boundedFact(facts: Readonly<Record<string, unknown>>, key: string): string {
    const value = String(facts[key] ?? '').trim();
    if (value.length > 1000) {
      throw new ApiError(422, 'validation_failed', 'That is longer than a blocker fact can be', [
        { field: key, message: 'must be at most 1000 characters' },
      ]);
    }
    return value;
  }

  /**
   * Soft-delete. There is no hard delete, and the repository's note explains why.
   *
   * Audited, because a work item disappearing from every list is exactly the kind of change
   * someone will later need to account for — and unlike `archived`, it is not part of the
   * lifecycle anyone can see.
   */
  async softDelete(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<void> {
    const before = await this.readForWrite(context, principal, workItemId, 'work.update');

    await this.database.transaction(context, async (tx) => {
      // No version token, and that is the repository's shape rather than an oversight here:
      // `softDelete` is idempotent — deleting an already-deleted row changes nothing — so
      // there is no lost update for a version to prevent.
      await this.workItems.softDelete(tx, context, workItemId);

      await this.audit?.record(tx, context, {
        action: 'work_item.deleted',
        objectId: workItemId,
        result: 'allowed',
        metadata: {
          project_id: before.projectId,
          state_at_deletion: before.state,
          audience: before.audience,
        },
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The read that precedes every write.
   *
   * It exists so that a caller who may not read a row cannot discover it by trying to change
   * it: the 404 for "no relation" is produced here, before the write is attempted, and is the
   * same 404 `get` produces for a row that does not exist.
   */
  /**
   * Translate the repository's write failures.
   *
   * `WorkItemVersionConflictError` is a **409**, and that is the whole point of the token:
   * §3 step 7 asks for optimistic concurrency, and a conflict that surfaced as a 500 would
   * be indistinguishable from a server fault — so a client would retry it, which is exactly
   * the lost update the token exists to prevent.
   */
  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WorkItemVersionConflictError) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, [
          { field: 'version', message: 'the item changed since you read it' },
        ]);
      }
      if (error instanceof WorkItemNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      throw error;
    }
  }

  private async readForWrite(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    capability: 'work.update' | 'work.transition',
  ): Promise<WorkItemRow> {
    const row = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, workItemId),
    );

    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability,
      resource: this.resourceOf(row),
    });
    if (!verdict.allowed) {
      // Forbidden rather than not-found, and the difference is deliberate: the caller has
      // already been allowed to *read* this row, so its existence is not a secret from them.
      // Pretending otherwise would tell someone who can see a work item that it vanished when
      // they tried to change it.
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }

    return row;
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: this.resourceOf(row),
    }).allowed;
  }

  /**
   * Whether this principal may read a predecessor, judged against the predecessor's own
   * project and audience rather than the dependent item's. The health signal calls this
   * before it discloses a predecessor's identifying details; a `false` here means the caller
   * has no relation to that predecessor's project and must see only a redacted signal.
   *
   * The predecessor is already past the deleted and landed (done/archived) filters by the
   * time this runs, so its lifecycle is `active` — the same value {@link resourceOf} would
   * derive for it.
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
        lifecycle: 'active',
      },
    }).allowed;
  }

  private resourceOf(row: WorkItemRow) {
    return {
      organizationId: row.organizationId,
      projectId: row.projectId,
      audience: row.audience,
      lifecycle: row.deletedAt
        ? ('soft_deleted' as const)
        : row.state === 'archived'
          ? ('archived' as const)
          : ('active' as const),
    };
  }

  /**
   * F26: whether this principal may publish work to the clients of `projectId`. A 403, not a 404:
   * the caller has already passed the relation check on this project, so it is not a secret.
   */
  private requirePublish(principal: Principal, context: TenantContext, projectId: string): void {
    const verdict = authorize({
      principal,
      capability: 'deliverable.publish',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'work_item_publish_denied',
      );
    }
  }

  /**
   * Whether this principal may act on that project at all.
   *
   * Used by `create`, where there is no row yet to authorize against — the project is the only
   * thing to check, and `authorize()` is asked about a hypothetical internal item in it. The
   * refusal is 404, matching every other "you have no relation to this" answer in the system.
   */
  private requireProjectRelation(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    capability: 'work.create',
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });

    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }
  }
}

/** Re-exported so the controller can name the initial state without importing the machine. */
export const WORK_ITEM_INITIAL_STATE = workItemStateMachine.definition.initial;
