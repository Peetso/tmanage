import { authorize, workItemStateMachine } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  effectivePageSize,
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
  readonly state: string;
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
export function toWorkItemView(row: WorkItemRow): WorkItemView {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    title: row.title,
    state: row.state,
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
    };

export interface WorkItemHealthView {
  readonly status: 'blocked' | 'at_risk' | 'on_track';
  readonly signals: readonly WorkItemHealthSignal[];
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

    return readable.map(toView);
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
    return toView(row);
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

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.workItems.create(tx, context, input);

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

      return created;
    });

    return toView(row);
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
    input: UpdateWorkItemInput,
  ): Promise<WorkItemView> {
    const before = await this.readForWrite(context, principal, workItemId, 'work.update');

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

        return updated;
      }),
    );

    return toView(row);
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

      return toView(row);
    } catch (error) {
      if (error instanceof WorkItemTransitionError) {
        throw new ApiError(
          422,
          'validation_failed',
          `A work item cannot move from ${error.from} to ${error.to}`,
          error.missing.map((fact) => ({
            field: fact,
            message: 'is required for this transition',
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
   * every health answer — and the edge must be acyclic, which the repository proves
   * against the rows before inserting.
   */
  async addDependency(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    dependsOnWorkItemId: string,
  ): Promise<WorkItemDependencyView> {
    await this.readForWrite(context, principal, workItemId, 'work.update');
    // The predecessor needs only readability: depending on work is not editing it.
    const predecessor = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, dependsOnWorkItemId),
    );
    if (!predecessor || predecessor.deletedAt !== null || !this.mayRead(principal, predecessor)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.graph.addDependency(tx, context, workItemId, dependsOnWorkItemId),
      );
      return {
        id: row.id,
        workItemId: row.workItemId,
        dependsOnWorkItemId: row.dependsOnWorkItemId,
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
        throw new ApiError(422, 'validation_failed', 'That dependency would create a cycle', [
          { field: 'dependsOnWorkItemId', message: 'already depends on this work item' },
        ]);
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

    const now = new Date();
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
      if (predecessor.state === 'blocked') {
        signals.push({
          kind: 'predecessor_blocked',
          workItemId: predecessor.workItemId,
          title: predecessor.title,
        });
      } else if (predecessor.dueAt !== null && predecessor.dueAt < now) {
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
