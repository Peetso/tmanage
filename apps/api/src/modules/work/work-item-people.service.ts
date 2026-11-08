import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { AssigneeRole } from './work-item-assignees.repository.js';
import { WorkWatchersRepository } from './watchers.repository.js';

/**
 * C26 — the people on a task: doers (the owner is the lead), supervisors and watchers.
 *
 * Reading is `work.read` on the item; changing anyone's role on it is `work.update`, the same
 * gate as changing the owner, and every person named must be an active member of this
 * organization (the owner rule). Setting the doers sets the owner to the first one and clearing
 * them clears it, in the same transaction. People newly given a role are told in-app through
 * `work_item.people_assigned.v1` (internal members only — the worker re-checks each one's reach).
 */
export interface WorkItemPeopleView {
  /** Lead first. With no doer rows this is the owner alone (or empty). */
  readonly doerUserIds: readonly string[];
  readonly supervisorUserIds: readonly string[];
  readonly watcherUserIds: readonly string[];
  /** C27: the reader's own user id, so the screen can tell "I supervise this" apart. */
  readonly viewerUserId: string;
}

export const MAX_PEOPLE_PER_ROLE = 50;

/** C27: the audit cause of a "Mark done" refused because a supervisor must approve it. */
export const SUPERVISOR_APPROVAL_REQUIRED = 'supervisor_approval_required';

/**
 * C27 — who may move a task to `done`. A task with no supervisors: anyone the transition gate
 * lets through (unchanged). A task with supervisors: only one of them, which is the approval —
 * the doer's "Mark done" stops in internal review and waits for it.
 */
export function mayCompleteSupervised(
  supervisorUserIds: readonly string[],
  actorUserId: string,
): boolean {
  return supervisorUserIds.length === 0 || supervisorUserIds.includes(actorUserId);
}

/**
 * C27 — who may take someone off a task's watchers: anyone may remove themselves (the item must
 * still be readable); removing another person is `work.update`, the people routes' edit gate.
 */
export function watcherRemovalCapability(
  targetUserId: string,
  actorUserId: string,
): 'work.read' | 'work.update' {
  return targetUserId === actorUserId ? 'work.read' : 'work.update';
}

/** Dedupe, keep order, cap. A non-list or a bad id is a 400 at the controller, not here. */
export function normalisePeople(userIds: readonly string[]): readonly string[] {
  return [...new Set(userIds)].slice(0, MAX_PEOPLE_PER_ROLE);
}

/** The doer list as the screen shows it: the owner first, then the other doer rows in order. */
export function doersWithLead(
  ownerUserId: string | null,
  doerRowUserIds: readonly string[],
): readonly string[] {
  if (ownerUserId === null) return doerRowUserIds;
  return [ownerUserId, ...doerRowUserIds.filter((id) => id !== ownerUserId)];
}

export class WorkItemPeopleService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly outbox?: OutboxEventsRepository,
    private readonly assignees: WorkItemAssigneesRepository = new WorkItemAssigneesRepository(),
    private readonly watchers: WorkWatchersRepository = new WorkWatchersRepository(),
  ) {}

  async read(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemPeopleView> {
    return this.database.read(context, async (runner) => {
      const row = await this.parent(runner, context, principal, workItemId, 'work.read');
      return this.viewOf(runner, context, row);
    });
  }

  /** Replace the doers (lead first) or the supervisors as a set. */
  async setRole(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    role: AssigneeRole,
    requested: readonly string[],
  ): Promise<WorkItemPeopleView> {
    const userIds = normalisePeople(requested);
    return this.database.transaction(context, async (tx) => {
      const row = await this.parent(tx, context, principal, workItemId, 'work.update');
      const members = await this.requireMembers(tx, context, userIds);
      const before = await this.viewOf(tx, context, row);
      await this.assignees.replaceRole(
        tx,
        context,
        workItemId,
        role,
        userIds.map((id) => members.get(id) as string),
      );
      if (role === 'doer') {
        const lead = userIds[0] ?? null;
        if (lead !== row.ownerUserId) await this.assignees.setLead(tx, context, workItemId, lead);
      }
      const was = role === 'doer' ? before.doerUserIds : before.supervisorUserIds;
      await this.tell(
        tx,
        context,
        row,
        role,
        userIds.filter((id) => !was.includes(id)),
      );
      return this.viewOf(tx, context, {
        ...row,
        ownerUserId: role === 'doer' ? (userIds[0] ?? null) : row.ownerUserId,
      });
    });
  }

  /** Add several watchers at once. Idempotent per person; returns how many were added. */
  async addWatchers(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    requested: readonly string[],
  ): Promise<{ readonly added: number }> {
    const userIds = normalisePeople(requested);
    return this.database.transaction(context, async (tx) => {
      await this.parent(tx, context, principal, workItemId, 'work.update');
      const members = await this.requireMembers(tx, context, userIds);
      let added = 0;
      for (const userId of userIds) {
        const memberId = members.get(userId) as string;
        if (await this.watchers.findForMember(tx, context, workItemId, memberId)) continue;
        await this.watchers.create(tx, context, { workItemId, memberId });
        added += 1;
      }
      return { added };
    });
  }

  /** C27: take one person off the watchers. Idempotent: someone not watching is a no-op. */
  async removeWatcher(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    userId: string,
  ): Promise<{ readonly removed: boolean }> {
    return this.database.transaction(context, async (tx) => {
      const capability = watcherRemovalCapability(userId, context.userId);
      await this.parent(tx, context, principal, workItemId, capability);
      const memberId = (await this.assignees.activeMemberships(tx, context, [userId])).get(userId);
      if (memberId === undefined) return { removed: false };
      if (!(await this.watchers.findForMember(tx, context, workItemId, memberId))) {
        return { removed: false };
      }
      await this.watchers.deleteForMember(tx, context, workItemId, memberId);
      return { removed: true };
    });
  }

  private async viewOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: WorkItemRow,
  ): Promise<WorkItemPeopleView> {
    const rows = await this.assignees.list(runner, context, row.id);
    return {
      doerUserIds: doersWithLead(
        row.ownerUserId,
        rows.filter((r) => r.role === 'doer').map((r) => r.userId),
      ),
      supervisorUserIds: rows.filter((r) => r.role === 'supervisor').map((r) => r.userId),
      watcherUserIds: await this.assignees.watcherUserIds(runner, context, row.id),
      viewerUserId: context.userId,
    };
  }

  private async requireMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const members = await this.assignees.activeMemberships(runner, context, userIds);
    if (userIds.some((id) => !members.has(id))) {
      throw new ApiError(422, 'validation_failed', 'Someone is not a member', [
        { field: 'userIds', message: 'must be active members of this organization' },
      ]);
    }
    return members;
  }

  private async tell(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: WorkItemRow,
    role: AssigneeRole,
    added: readonly string[],
  ): Promise<void> {
    const userIds = added.filter((id) => id !== context.userId);
    if (userIds.length === 0) return;
    await this.outbox?.append(runner, context, {
      type: 'work_item.people_assigned.v1',
      aggregateId: row.id,
      payload: {
        workItemId: row.id,
        projectId: row.projectId,
        role,
        userIds,
        assignedByUserId: context.userId,
      },
    });
  }

  /** Resolve the item tenant-scoped, then authorize: unreadable is 404, read-only is 403. */
  private async parent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    capability: 'work.read' | 'work.update',
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !allowed(principal, row, 'work.read')) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (capability === 'work.update' && !allowed(principal, row, 'work.update')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    return row;
  }
}

function allowed(
  principal: Principal,
  row: WorkItemRow,
  capability: 'work.read' | 'work.update',
): boolean {
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
