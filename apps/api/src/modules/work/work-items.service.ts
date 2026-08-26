import { authorize, workItemStateMachine } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  WorkItemNotFoundError,
  WorkItemsRepository,
  WorkItemTransitionError,
  WorkItemVersionConflictError,
} from './work-items.repository.js';
import type {
  CreateWorkItemInput,
  ListWorkItemsOptions,
  UpdateWorkItemInput,
} from './work-items.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';

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
 */
function toView(row: WorkItemRow): WorkItemView {
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
    version: Number(row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/**
 * The audiences a client principal may read.
 *
 * `internal` is absent, and that absence is the control. `12-PERMISSION-MATRIX` §2 and the
 * isolation spec §7 both say a client sees published work and their own actions; an internal
 * item is not a narrower view of the same row, it is a row they must not know exists.
 */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

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
  ) {}

  /**
   * List the work this principal may read.
   *
   * The audience allowlist is applied **before** the query for a client principal, so an
   * internal item never leaves the database. The relation check then runs per row, because
   * `authorize()` is the one place that rule is written.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListWorkItemsOptions = {},
  ): Promise<readonly WorkItemView[]> {
    const scoped: ListWorkItemsOptions =
      principal.kind === 'client' ? { ...options, audiences: CLIENT_AUDIENCES } : options;

    const rows = await this.database.read(context, (runner) =>
      this.workItems.list(runner, context, scoped),
    );

    return rows.filter((row) => this.mayRead(principal, row)).map(toView);
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
      throw error;
    }
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
