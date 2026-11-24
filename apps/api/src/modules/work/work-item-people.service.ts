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
import type { AuditService } from '../audit/audit.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { AssigneeRole } from './work-item-assignees.repository.js';
import { WorkWatchersRepository } from './watchers.repository.js';
import { WorkAiPeopleGate } from './work-ai-people.js';
import type { AiPeopleDecisions, WorkAiPeoplePort } from './work-ai-people.js';

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

/** 60-08: the people read as the screen asks it, with the AI-employee decisions (AR-9). */
export interface WorkItemPeopleReadView extends WorkItemPeopleView, AiPeopleDecisions {}

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

/**
 * Work area (2026-11-23) — a change to the people on an item, as the create, the update and the
 * people routes all send it. A role left out is left alone; `[]` clears it. Doers are lead first.
 */
export interface PeopleChange {
  readonly doerUserIds?: readonly string[];
  readonly supervisorUserIds?: readonly string[];
  readonly watcherUserIds?: readonly string[];
}

/** What {@link applyPeopleChange} writes through. Stateless repositories plus the two sinks. */
export interface PeopleWritePorts {
  readonly assignees: WorkItemAssigneesRepository;
  readonly watchers: WorkWatchersRepository;
  readonly outbox?: OutboxEventsRepository;
  readonly audit?: Pick<AuditService, 'record'>;
  /** 60-08: the AI-employee rules (one AI doer, a person supervises, who may assign). */
  readonly ai: WorkAiPeoplePort;
}

/** Every person a change names, once, for one membership read. */
function namedIn(change: PeopleChange): readonly string[] {
  return [
    ...new Set([
      ...(change.doerUserIds ?? []),
      ...(change.supervisorUserIds ?? []),
      ...(change.watcherUserIds ?? []),
    ]),
  ];
}

/** Whether a change names any role at all. */
export function hasPeopleChange(change: PeopleChange): boolean {
  return (
    change.doerUserIds !== undefined ||
    change.supervisorUserIds !== undefined ||
    change.watcherUserIds !== undefined
  );
}

/** Dedupe and cap each role a change names; a role left out stays out. */
export function normalisePeopleChange(requested: PeopleChange): PeopleChange {
  return {
    ...(requested.doerUserIds === undefined
      ? {}
      : { doerUserIds: normalisePeople(requested.doerUserIds) }),
    ...(requested.supervisorUserIds === undefined
      ? {}
      : { supervisorUserIds: normalisePeople(requested.supervisorUserIds) }),
    ...(requested.watcherUserIds === undefined
      ? {}
      : { watcherUserIds: normalisePeople(requested.watcherUserIds) }),
  };
}

/**
 * Write a people change inside the caller's transaction: the one implementation behind
 * `POST /work-items` (people from the start), `PATCH /work-items/:id` and `PUT …/people/*`, so the
 * three cannot drift (AR-11). Every person must be an active member (422, nothing written). The
 * doer rows are the single source (0412); the lead (first doer) is written to the owner only when
 * the caller has not already done so (`row.ownerUserId` is the owner after the caller's write).
 * People newly given a doer or supervisor role are told through the outbox (AS-1), and one audit
 * row records the counts per role before and after (DA-11; never names).
 */
export async function applyPeopleChange(
  runner: TenantQueryRunner,
  context: TenantContext,
  ports: PeopleWritePorts,
  row: WorkItemRow,
  requested: PeopleChange,
  options: {
    /**
     * The people as they were before the caller's own write in this transaction (an owner change
     * moves the lead row first), so the audit row and the notices compare with the real before.
     */
    readonly before?: WorkItemPeopleView;
    /** 60-08: who is asking, for the AI-employee assign decision (absent: refused). */
    readonly principal?: Principal;
    /** 60-08: a new item, so every doer it names is a new assignment (the lead included). */
    readonly creating?: boolean;
    /** 60-08: the same request moved the item to another project. */
    readonly projectChanged?: boolean;
  } = {},
): Promise<WorkItemPeopleView> {
  const change = normalisePeopleChange(requested);
  const people = namedIn(change);
  const members = await ports.assignees.activeMemberships(runner, context, people);
  if (people.some((id) => !members.has(id))) {
    throw new ApiError(422, 'validation_failed', 'Someone is not a member', [
      { field: 'userIds', message: 'must be active members of this organization' },
    ]);
  }
  const before = options.before ?? (await readPeople(runner, context, ports, row));
  let ownerUserId = row.ownerUserId;

  if (change.doerUserIds !== undefined) {
    const ids = change.doerUserIds;
    await ports.assignees.replaceRole(
      runner,
      context,
      row.id,
      'doer',
      ids.map((id) => members.get(id) as string),
    );
    const lead = ids[0] ?? null;
    if (lead !== row.ownerUserId) await ports.assignees.setLead(runner, context, row.id, lead);
    ownerUserId = lead;
  }
  if (change.supervisorUserIds !== undefined) {
    await ports.assignees.replaceRole(
      runner,
      context,
      row.id,
      'supervisor',
      change.supervisorUserIds.map((id) => members.get(id) as string),
    );
  }
  if (change.watcherUserIds !== undefined) {
    const wanted = new Set(change.watcherUserIds);
    const stale = before.watcherUserIds.filter((id) => !wanted.has(id));
    const staleMembers = await ports.assignees.activeMemberships(runner, context, stale);
    for (const userId of stale) {
      const memberId = staleMembers.get(userId);
      if (memberId !== undefined) {
        await ports.watchers.deleteForMember(runner, context, row.id, memberId);
      }
    }
    for (const userId of change.watcherUserIds) {
      if (before.watcherUserIds.includes(userId)) continue;
      await ports.watchers.create(runner, context, {
        workItemId: row.id,
        memberId: members.get(userId) as string,
      });
    }
  }

  const written = await readPeople(runner, context, ports, { ...row, ownerUserId });
  // 60-08: the AI-employee rules see the people as written, in this transaction; a refusal rolls
  // the whole change back, and a defaulted supervisor is audited and counted with the rest.
  const supervisorUserIds = await ports.ai.settle(runner, context, {
    principal: options.principal,
    row: { ...row, ownerUserId },
    after: written,
    baselineDoerUserIds: options.creating === true ? [] : before.doerUserIds,
    supervisorsNamed: change.supervisorUserIds !== undefined,
    projectChanged: options.projectChanged ?? false,
    assignees: ports.assignees,
  });
  const after: WorkItemPeopleView = { ...written, supervisorUserIds };
  for (const role of ['doer', 'supervisor'] as const) {
    const was = role === 'doer' ? before.doerUserIds : before.supervisorUserIds;
    const now = role === 'doer' ? after.doerUserIds : after.supervisorUserIds;
    const added = now.filter((id) => !was.includes(id) && id !== context.userId);
    if (added.length === 0) continue;
    await ports.outbox?.append(runner, context, {
      type: 'work_item.people_assigned.v1',
      aggregateId: row.id,
      payload: {
        workItemId: row.id,
        projectId: row.projectId,
        role,
        userIds: added,
        assignedByUserId: context.userId,
      },
    });
  }
  const changed =
    !sameList(before.doerUserIds, after.doerUserIds) ||
    !sameList(before.supervisorUserIds, after.supervisorUserIds) ||
    !sameList(before.watcherUserIds, after.watcherUserIds);
  if (changed) {
    await ports.audit?.record(runner, context, {
      action: 'work_item.people_changed',
      objectId: row.id,
      result: 'allowed',
      metadata: {
        project_id: row.projectId,
        doers_before: before.doerUserIds.length,
        doers_after: after.doerUserIds.length,
        supervisors_before: before.supervisorUserIds.length,
        supervisors_after: after.supervisorUserIds.length,
        watchers_before: before.watcherUserIds.length,
        watchers_after: after.watcherUserIds.length,
        lead_changed: before.doerUserIds[0] !== after.doerUserIds[0],
      },
    });
  }
  return after;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => b[index] === id);
}

/** The people on an item as the screen reads them (lead first). */
export async function readPeople(
  runner: TenantQueryRunner,
  context: TenantContext,
  ports: Pick<PeopleWritePorts, 'assignees'>,
  row: WorkItemRow,
): Promise<WorkItemPeopleView> {
  const rows = await ports.assignees.list(runner, context, row.id);
  return {
    doerUserIds: doersWithLead(
      row.ownerUserId,
      rows.filter((r) => r.role === 'doer').map((r) => r.userId),
    ),
    supervisorUserIds: rows.filter((r) => r.role === 'supervisor').map((r) => r.userId),
    watcherUserIds: await ports.assignees.watcherUserIds(runner, context, row.id),
    viewerUserId: context.userId,
  };
}

export class WorkItemPeopleService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly outbox?: OutboxEventsRepository,
    private readonly assignees: WorkItemAssigneesRepository = new WorkItemAssigneesRepository(),
    private readonly watchers: WorkWatchersRepository = new WorkWatchersRepository(),
    /** Work area: every people change is audited (`work_item.people_changed`). */
    private readonly audit?: Pick<AuditService, 'record'>,
    /** 60-08: the AI-employee rules; the app always uses the real gate. */
    private readonly aiPeople: WorkAiPeoplePort = new WorkAiPeopleGate(),
  ) {}

  private ports(): PeopleWritePorts {
    return {
      assignees: this.assignees,
      watchers: this.watchers,
      ai: this.aiPeople,
      ...(this.outbox === undefined ? {} : { outbox: this.outbox }),
      ...(this.audit === undefined ? {} : { audit: this.audit }),
    };
  }

  async read(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemPeopleReadView> {
    return this.database.read(context, async (runner) => {
      const row = await this.parent(runner, context, principal, workItemId, 'work.read');
      const people = await this.viewOf(runner, context, row);
      return {
        ...people,
        ...(await this.aiPeople.decide(runner, context, principal, row, people)),
      };
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
    return this.database.transaction(context, async (tx) => {
      const row = await this.parent(tx, context, principal, workItemId, 'work.update');
      return applyPeopleChange(
        tx,
        context,
        this.ports(),
        row,
        role === 'doer' ? { doerUserIds: requested } : { supervisorUserIds: requested },
        { principal },
      );
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
      await this.aiPeople.refuseAiWatchers(tx, context, userIds);
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

  private viewOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: WorkItemRow,
  ): Promise<WorkItemPeopleView> {
    return readPeople(runner, context, { assignees: this.assignees }, row);
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
