import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7, workItemStateMachine } from '@tmanage/domain';
import type { Audience, WorkItemState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItems } from '../../common/database/schema.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work items — WORK-001's storage half, and the child-of-a-tenant-parent ADR-0001 uses as
 * *the* composite-foreign-key example.
 *
 * Follows `ProjectsRepository`: `TenantContext` as the scoping parameter, no `organizationId`
 * on any input type, keyset pagination, optimistic concurrency, not-found rather than conflict
 * for a caller in the wrong tenant.
 *
 * ## Concurrency is a real `version` column here
 *
 * `work_items` has one, so this repository uses it rather than `updated_at`. It is the better
 * token — two edits in the same millisecond are distinguishable, where `DATETIME(3)` equality
 * is not — and a work item is exactly the row two people edit at once. `projects` and the two
 * client tables have no version column and use `updated_at`; the repository uses whichever the
 * table actually provides.
 *
 * ## State is a checked transition, never a free assignment
 *
 * `23-ERD-AND-STATE-MACHINES` §5 defines the lifecycle and `packages/domain` already
 * implements it as data. {@link transitionState} runs the row's current state through
 * `workItemStateMachine` inside the same unit of work, so an illegal move — or a legal one
 * missing a required fact, such as `done` without an owner and a completion timestamp — is
 * refused by the machine rather than by a hand-written `if` that drifts from the diagram.
 *
 * There is deliberately **no** `state` field on {@link UpdateWorkItemInput}. Assigning a state
 * directly is how a lifecycle stops being a lifecycle.
 *
 * ## Audience is a field on the row, and this repository does not police it
 *
 * `audience` decides whether an item is internal, client-visible, or in a client's action
 * queue. Widening it (internal → client_visible) is a publication decision that
 * `12-PERMISSION-MATRIX` gates on capability and that `isVisibilityWidening` in
 * `packages/domain` recognises — but that is an authorization question about a *principal*,
 * and a repository has no principal. It stores what it is told and the service decides who may
 * tell it. What the repository does guarantee is that no client-audience filter can be
 * *forgotten* silently: {@link ListWorkItemsOptions.audiences} is an explicit allowlist, and
 * omitting it returns every audience, which is only ever correct for an internal reader.
 *
 * ## A schema defect found while writing this, not fixed here
 *
 * `work_items.state` has `DEFAULT 'triage'` in `0001_tenancy.sql`, and `triage` is **not a
 * work-item state**. It belongs to the client-request lifecycle (`23-ERD` §7). §5 gives
 * `backlog` as the initial state. Nothing depends on the default today — the seed sets the
 * column explicitly and so does {@link create}, which takes its default from
 * `workItemStateMachine.definition.initial` rather than from the column — so the defect is
 * latent rather than active. Correcting it is a migration, which the current task explicitly
 * scoped out, so it is recorded in `docs/implementation-status.md` rather than changed here.
 */

export class WorkItemNotFoundError extends Error {
  constructor(readonly workItemId: string) {
    // No organization id and no project id in the message. A caller probing for another
    // tenant's work item should learn nothing from the difference between "does not exist"
    // and "exists elsewhere" (spec §4).
    super(`Work item ${workItemId} was not found`);
    this.name = 'WorkItemNotFoundError';
  }
}

export class WorkItemVersionConflictError extends Error {
  constructor(
    readonly workItemId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Work item ${workItemId} was modified concurrently (expected version ${expectedVersion})`,
    );
    this.name = 'WorkItemVersionConflictError';
  }
}

export class WorkItemTransitionError extends Error {
  constructor(
    readonly from: WorkItemState,
    readonly to: WorkItemState,
    readonly reason: 'illegal_transition' | 'missing_requirement',
    /** Named facts the transition required and did not get. Empty for an illegal move. */
    readonly missing: readonly string[],
    detail: string,
  ) {
    // `detail` comes from the state machine and is documented there as stable and
    // non-sensitive: it names states and required field names, never row content.
    super(detail);
    this.name = 'WorkItemTransitionError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field
 * for a request body to populate and no code path that could prefer one over the other.
 *
 * Note also what is absent second: there is no `state`. A new work item starts at the
 * lifecycle's initial state and moves through {@link WorkItemsRepository.transitionState}.
 */
export interface CreateWorkItemInput {
  readonly projectId: string;
  readonly title: string;
  readonly type?: string;
  readonly ownerUserId?: string | null;
  readonly audience?: Audience;
  readonly startAt?: Date | null;
  readonly dueAt?: Date | null;
}

/** No `state`. See the note on the class about why that is deliberate. */
export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly type?: string;
  readonly ownerUserId?: string | null;
  readonly audience?: Audience;
  readonly startAt?: Date | null;
  readonly dueAt?: Date | null;
}

export interface ListWorkItemsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is by id. */
  readonly after?: string;
  readonly limit?: number;
  /** Restrict to one project. Omitted, the whole tenant's work. */
  readonly projectId?: string;
  readonly states?: readonly WorkItemState[];
  /**
   * Restrict to these audiences. **Omitting this returns every audience**, which is only ever
   * correct for an internal reader — a client projection must always pass the allowlist.
   */
  readonly audiences?: readonly Audience[];
  /** Soft-deleted items are excluded unless asked for. */
  readonly includeDeleted?: boolean;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The page size a caller's request actually resolves to, clamped the way {@link list} clamps it. */
export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/**
 * What `internal_review -> done` writes besides the state. Parsed and validated by the
 * service from the machine's `ownerId` and `completedAt` facts; the repository writes the
 * columns and does not judge them.
 */
export interface WorkItemCompletion {
  readonly ownerUserId: string;
  readonly completedAt: Date;
}

export class WorkItemsRepository {
  /**
   * One page of rows, in id order, **before** any per-row authorization. The service applies
   * `mayRead` and — because that filter can shorten a page — keeps asking for the next page
   * until it has a full one or the table runs out. A caller that treats one call here as one
   * page of *readable* rows has the defect the service closes.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListWorkItemsOptions = {},
  ): Promise<readonly WorkItemRow[]> {
    const limit = effectivePageSize(options.limit);

    const predicates = [eq(workItems.organizationId, context.organizationId)];
    if (options.projectId) predicates.push(eq(workItems.projectId, options.projectId));
    if (options.states && options.states.length > 0) {
      predicates.push(inArray(workItems.state, [...options.states]));
    }
    if (options.audiences && options.audiences.length > 0) {
      predicates.push(inArray(workItems.audience, [...options.audiences]));
    }
    if (!options.includeDeleted) predicates.push(isNull(workItems.deletedAt));
    if (options.after) predicates.push(gt(workItems.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(workItems)
      .where(and(...predicates))
      .orderBy(asc(workItems.id))
      .limit(limit);
  }

  /**
   * Fetch one work item by id, within the acting tenant.
   *
   * There is deliberately no `findById(id)` without a context. On MySQL such a method returns
   * another customer's work item, which is the whole reason ADR-0001 exists.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkItemRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.organizationId, context.organizationId), eq(workItems.id, workItemId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch several work items by id in one query, within the acting tenant.
   *
   * An id that names nothing — or another tenant's row, which the predicate never selects —
   * is simply absent from the result; the caller decides what an absence means. Soft-deleted
   * rows are returned like any other, so the service applies the same `deletedAt` and
   * relation rules `get` applies, row by row. The order is the database's, not the ids'.
   */
  async findManyByIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<readonly WorkItemRow[]> {
    if (workItemIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          inArray(workItems.id, [...workItemIds]),
        ),
      );
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const found = await this.findById(runner, context, workItemId);
    if (!found) throw new WorkItemNotFoundError(workItemId);
    return found;
  }

  /**
   * Create a work item at the lifecycle's initial state.
   *
   * The id is generated here rather than by the database: `07-DATA-MODEL` fixes
   * application-generated UUIDv7 stored as canonical lowercase `CHAR(36)`, which lets a
   * command know the id before the insert commits — necessary for writing the outbox event and
   * the audit event in the same transaction (spec §3 step 8).
   *
   * The project is *not* checked to belong to the tenant here. That is not an oversight:
   * `fk_work_items_project_tenant` is a composite foreign key including `organization_id`, so
   * the database refuses a project from another organization. This is the constraint ADR-0001
   * layer 1 is named for, and duplicating it in the service would only give it somewhere to
   * drift from.
   *
   * `state` is written explicitly from `workItemStateMachine.definition.initial` rather than
   * left to the column default — see the schema-defect note on the class.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkItemInput,
  ): Promise<WorkItemRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(workItems)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        projectId: input.projectId,
        type: input.type ?? 'task',
        title: input.title,
        state: workItemStateMachine.definition.initial,
        ownerUserId: input.ownerUserId ?? null,
        audience: input.audience ?? 'internal',
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /** Update a work item's fields, refusing a stale write. Never its state. */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    expectedVersion: number,
    input: UpdateWorkItemInput,
  ): Promise<WorkItemRow> {
    const changes: Record<string, unknown> = {
      version: sql`version + 1`,
      updatedAt: sql`current_timestamp(3)`,
    };
    if (input.title !== undefined) changes['title'] = input.title;
    if (input.type !== undefined) changes['type'] = input.type;
    if (input.ownerUserId !== undefined) changes['ownerUserId'] = input.ownerUserId;
    if (input.audience !== undefined) changes['audience'] = input.audience;
    if (input.startAt !== undefined) changes['startAt'] = input.startAt;
    if (input.dueAt !== undefined) changes['dueAt'] = input.dueAt;

    const result = await tenantDrizzle(runner)
      .update(workItems)
      .set(changes)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.id, workItemId),
          eq(workItems.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Zero rows means one of three things: wrong tenant, no such item, or a stale token.
      // They are distinguished by a scoped read, so a caller in the wrong tenant still gets
      // "not found" rather than a conflict that confirms the row exists.
      const current = await this.findById(runner, context, workItemId);
      if (!current) throw new WorkItemNotFoundError(workItemId);
      throw new WorkItemVersionConflictError(workItemId, current.version);
    }

    return this.requireById(runner, context, workItemId);
  }

  /**
   * Move a work item through its lifecycle, refusing both a stale write and an illegal move.
   *
   * The current state is read inside the same unit of work and the transition is checked
   * against it by `workItemStateMachine`, then the write itself re-states `version` — so a
   * concurrent change between the read and the write loses rather than slipping through the
   * check that was made against the state it has just stopped being in.
   *
   * `facts` carries the named requirements §5 attaches to particular moves: `blockerReason`
   * and `blockerAsk` entering `blocked`, `blockerResolution` leaving it, `ownerId` and
   * `completedAt` for `done`, `reopenReason` to reopen. The machine decides what is required;
   * this method only supplies what it was given and surfaces what was missing.
   *
   * Two of those facts are columns, and this is where they are written (0013). Reaching
   * `done` sets `owner_user_id` and `completed_at` from `completion`, which the service has
   * already parsed and validated from the facts; the machine's own check runs first, so a
   * move the machine refuses never reaches the write. Leaving `done` for `in_progress` —
   * §5's reopen — clears `completed_at`: an item back in progress is not completed. Every
   * other move leaves both columns alone.
   */
  async transitionState(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    expectedVersion: number,
    to: WorkItemState,
    facts: Readonly<Record<string, unknown>> = {},
    completion?: WorkItemCompletion,
  ): Promise<WorkItemRow> {
    const current = await this.requireById(runner, context, workItemId);
    // The column is `VARCHAR(32)`, so the row's state is a string as far as the type system is
    // concerned. The machine is the authority on whether it is a state at all, and an
    // unrecognised value simply has no outbound transition — it refuses rather than throwing
    // somewhere less obvious.
    const from = current.state as WorkItemState;

    const verdict = workItemStateMachine.transition(from, to, facts);
    if (!verdict.ok) {
      throw new WorkItemTransitionError(from, to, verdict.reason, verdict.missing, verdict.detail);
    }

    if (to === 'done' && !completion) {
      // The machine has just accepted `ownerId` and `completedAt`, so the service had both
      // facts and did not parse them. That is a programming error in the caller, not a
      // request to refuse politely — and writing `done` without the columns is the exact
      // defect 0013 exists to close.
      throw new Error(`Work item ${workItemId}: reaching done without a parsed completion`);
    }

    const result = await tenantDrizzle(runner)
      .update(workItems)
      .set({
        state: to,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
        ...(to === 'done' && completion
          ? { ownerUserId: completion.ownerUserId, completedAt: completion.completedAt }
          : {}),
        ...(from === 'done' && to === 'in_progress' ? { completedAt: null } : {}),
      })
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.id, workItemId),
          eq(workItems.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      const live = await this.findById(runner, context, workItemId);
      if (!live) throw new WorkItemNotFoundError(workItemId);
      throw new WorkItemVersionConflictError(workItemId, live.version);
    }

    return this.requireById(runner, context, workItemId);
  }

  /**
   * Soft-delete a work item. There is no hard delete.
   *
   * `04-SECURITY-PRIVACY` and the offboarding lifecycle both treat removal as a state, not an
   * erasure: audit events, outbox events, messages converted into this item and client-visible
   * history all reference this row, and a `DELETE` would either orphan them or cascade through
   * them.
   *
   * Distinct from the `archived` **state**, which is part of the lifecycle §5 defines and is
   * reached through {@link transitionState}. Archiving is a thing a person does to work that
   * is finished; deletion is a thing done to work that should not have been created. Collapsing
   * the two would make "we never started this" and "we finished this" the same row.
   */
  async softDelete(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const result = await tenantDrizzle(runner)
      .update(workItems)
      .set({
        deletedAt: sql`current_timestamp(3)`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.id, workItemId),
          isNull(workItems.deletedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, workItemId);
      if (!current) throw new WorkItemNotFoundError(workItemId);
      return current; // Already deleted; deleting twice is not an error.
    }

    return this.requireById(runner, context, workItemId);
  }
}
