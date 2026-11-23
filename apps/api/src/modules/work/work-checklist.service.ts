import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkChecklistRepository } from './work-checklist.repository.js';
import type { ChecklistItemWithAssignee } from './work-checklist.repository.js';
import { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { WorkItemView, WorkItemsService } from './work-items.service.js';

/**
 * x145's application service — the checklist / sub-items behind a work item (Work module 7).
 *
 * It is `WorkItemsService`'s shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the two rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path. The parent work item is read first, scoped to
 * the acting tenant — a `work_item_id` from another studio simply does not resolve, and the
 * answer is the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked
 * whether this principal may act on it, judged against the work item's own project and audience.
 * That order is the trap x145 was briefed on: a cross-tenant (or unrelated) parent is a 404 with
 * no write, never a row created against somebody else's work.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * A checklist item has no audience of its own; it inherits the parent work item's. The read gate
 * is `work.read` on that item; the write gate is `work.update`. A caller who may read the item
 * but not update it gets a 403 (their access to the item is not a secret); a caller with no
 * relation to the item at all gets a 404 (its existence is).
 *
 * ## Steps are the one model (work area D3, 0414)
 *
 * The checklist is the single model for the steps inside a work: `work_item_subtasks` was copied
 * in by 0414 and its routes are retired. A step may name who does it (an active member, else 422)
 * and the day it is due; it can be deleted, the steps reordered, and a step turned into a work of
 * its own in the same project. Delete, reorder and convert are audited in their transaction.
 */

/** The client-facing projection of one checklist item. Paired in `e2e/contracts`. */
export interface WorkChecklistItemView {
  readonly id: string;
  readonly workItemId: string;
  readonly label: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
  /** Work area D3: who does the step (a user id), `null` = nobody. */
  readonly assigneeUserId?: string | null;
  /** Work area D3: the day the step is due (`YYYY-MM-DD`), `null` = none. */
  readonly dueOn?: string | null;
}

export interface AddChecklistItemInput {
  readonly label: string;
  readonly assigneeUserId?: string | null;
  readonly dueOn?: string | null;
}

export interface UpdateChecklistItemInput {
  readonly label?: string;
  readonly done?: boolean;
  readonly assigneeUserId?: string | null;
  readonly dueOn?: string | null;
}

export class WorkChecklistService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly checklist: WorkChecklistRepository = new WorkChecklistRepository(),
    /** Work area D3: turning a step into a work goes through the one work-item writer. */
    private readonly workItemsService?: Pick<WorkItemsService, 'create'>,
    private readonly audit?: AuditService,
    private readonly assignees: WorkItemAssigneesRepository = new WorkItemAssigneesRepository(),
  ) {}

  /** The work item's checklist, position ascending. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkChecklistItemView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.checklist.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /** Append a checklist item. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddChecklistItemInput,
  ): Promise<WorkChecklistItemView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const assigneeMembershipId = await this.membershipOf(tx, context, input.assigneeUserId);
      const row = await this.checklist.create(tx, context, {
        workItemId,
        label: input.label,
        ...(assigneeMembershipId === undefined ? {} : { assigneeMembershipId }),
        ...(input.dueOn === undefined ? {} : { dueOn: input.dueOn }),
      });
      return toView(row);
    });
  }

  /** Toggle `done` and/or rename `label`. Behind `work.update` on the parent item. */
  async update(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
  ): Promise<WorkChecklistItemView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The item is resolved scoped to the tenant and its parent; a cross-tenant `itemId`, or one
      // belonging to another work item, does not resolve and is the same 404 as an absent id — no
      // write is attempted against it.
      const existing = await this.checklist.findItem(tx, context, workItemId, itemId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const assigneeMembershipId = await this.membershipOf(tx, context, input.assigneeUserId);
      const row = await this.checklist.update(tx, context, workItemId, itemId, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.done === undefined ? {} : { done: input.done }),
        ...(assigneeMembershipId === undefined ? {} : { assigneeMembershipId }),
        ...(input.dueOn === undefined ? {} : { dueOn: input.dueOn }),
      });
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return toView(row);
    });
  }

  /** Work area D3: delete a step. Behind `work.update`; audited as `work_item.step_deleted`. */
  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    itemId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const existing = await this.checklist.findItem(tx, context, workItemId, itemId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.checklist.delete(tx, context, workItemId, itemId);
      await this.audit?.record(tx, context, {
        action: 'work_item.step_deleted',
        objectId: workItemId,
        result: 'allowed',
        metadata: { step_id: itemId, was_done: existing.done },
      });
    });
  }

  /**
   * Work area D3: put the steps in a new order. `itemIds` must name every step of the work once
   * (400 otherwise). Behind `work.update`; audited as `work_item.steps_reordered`.
   */
  async reorder(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    itemIds: readonly string[],
  ): Promise<readonly WorkChecklistItemView[]> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const current = await this.checklist.listForWorkItem(tx, context, workItemId);
      const known = new Set(current.map((row) => row.id));
      if (
        itemIds.length !== current.length ||
        new Set(itemIds).size !== itemIds.length ||
        itemIds.some((id) => !known.has(id))
      ) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'itemIds', message: 'must list every step of this work exactly once' },
        ]);
      }
      await this.checklist.setPositions(tx, context, workItemId, itemIds);
      await this.audit?.record(tx, context, {
        action: 'work_item.steps_reordered',
        objectId: workItemId,
        result: 'allowed',
        metadata: { steps: itemIds.length },
      });
      return (await this.checklist.listForWorkItem(tx, context, workItemId)).map(toView);
    });
  }

  /**
   * Work area D3: turn a step into a work of its own in the same project — its label becomes the
   * title, its assignee the owner, its day the due date. The new work is made by
   * `WorkItemsService.create` (its capability, audit and outbox); then the step goes, audited as
   * `work_item.step_converted` naming the new work. Two units of work: if the second fails, the
   * step is still there beside the new work, so nothing is lost.
   */
  async convert(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    itemId: string,
  ): Promise<WorkItemView> {
    if (!this.workItemsService)
      throw new Error('WorkChecklistService: convert needs the work-items service');
    const { parent, step } = await this.database.read(context, async (runner) => {
      const parent = await this.readableParent(runner, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const step = await this.checklist.findItem(runner, context, workItemId, itemId);
      if (!step) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return { parent, step };
    });
    const created = await this.workItemsService.create(context, principal, {
      projectId: parent.projectId,
      title: step.label,
      ...(step.assigneeUserId ? { ownerUserId: step.assigneeUserId } : {}),
      ...(step.dueOn ? { dueAt: new Date(`${step.dueOn}T00:00:00.000Z`) } : {}),
    });
    await this.database.transaction(context, async (tx) => {
      await this.checklist.delete(tx, context, workItemId, itemId);
      await this.audit?.record(tx, context, {
        action: 'work_item.step_converted',
        objectId: workItemId,
        result: 'allowed',
        metadata: { step_id: itemId, new_work_item_id: created.id },
      });
    });
    return created;
  }

  /**
   * The membership an assignee user id names: `undefined` when not given, `null` to clear, else
   * the active member's membership id — anyone else is a 422, never a dangling assignee.
   */
  private async membershipOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (userId === undefined || userId === null) return userId;
    const found = await this.assignees.activeMemberships(runner, context, [userId]);
    const membershipId = found.get(userId);
    if (!membershipId) {
      throw new ApiError(
        422,
        'validation_failed',
        'That person is not a member of this workspace',
        [{ field: 'assigneeUserId', message: 'must be an active member' }],
      );
    }
    return membershipId;
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404
   * for "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist — so a caller cannot discover an item by trying to
   * hang a checklist off it.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      // Forbidden rather than not-found: the caller has already been allowed to read this item,
      // so its existence is not a secret from them.
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
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

function toView(row: ChecklistItemWithAssignee): WorkChecklistItemView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    label: row.label,
    done: row.done,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    assigneeUserId: row.assigneeUserId ?? null,
    dueOn: row.dueOn ?? null,
  };
}
