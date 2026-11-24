import { authorize, mayPassDoor } from '@tmanage/domain';
import type { MembershipKind, Principal } from '@tmanage/domain';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { aiEmployeesEnabled } from '../ai-employees/ai-employees.switch.js';
import { AiAssignFactsReader } from '../ai-employees/work-assign-facts.repository.js';
import type { AiAssignFacts } from '../ai-employees/work-assign-facts.repository.js';
import { WorkAiPeopleRepository } from './work-ai-people.repository.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';

/**
 * 60-08 (plan 60 v2 §2.2 step 5, §4.6, §4.7) — the rules for AI employees among a work's people,
 * enforced where every people write ends (`applyPeopleChange`, the owner and move paths of
 * `WorkItemsService`), inside the writer's transaction, after the write and before the audit row:
 *
 * 1. An AI employee is never a supervisor or a watcher (400). Watchers: an AI employee is told
 *    about work only through its assignments (agent contract), so a watch would reach no one.
 * 2. A task has at most one AI doer — "one open AI assignment per task" (409). People may share
 *    the task with it.
 * 3. A newly added AI doer needs: an assigner who is a person (door `assigner`), the server switch
 *    and the workspace switch on, capability `ai_employee.assign` on the project and the
 *    workspace's assign policy, the AI employee `active`, the project one of his and not closed
 *    to AI (403 / 409). A move to another project re-checks the project for the AI doer kept.
 * 4. While an AI employee does the task, at least one person supervises it. None named: the
 *    assigner, when a person, becomes the supervisor (§2.2 step 5 "default: PM"); a request that
 *    names the supervisors and leaves no person is refused (409), and so is a task nobody can
 *    supervise.
 *
 * Connection is **not** a rule: a task given to an AI employee without a live key waits in his
 * queue (§2.3 "finds the task on its next queue check") and §2.10's "not picked up" covers a
 * queue nobody reads; the picker shows "Not connected" so the choice is a conscious one.
 *
 * Every refusal is an `ApiError` with an audit cause `ai_employee:*`; the change rolls back with
 * the transaction. Rules: SE-1, AR-8 (doors and status from the domain), DA-11, DA-12, HT-1, IP-4.
 */

/** Who is who among a work's people after a write, as the rules read them. */
export interface AiPeopleSnapshot {
  readonly doerUserIds: readonly string[];
  readonly supervisorUserIds: readonly string[];
  readonly watcherUserIds: readonly string[];
}

export interface AiPeopleQuestion {
  readonly after: AiPeopleSnapshot;
  /** The doers before this request; an AI doer not among them is a new assignment. */
  readonly baselineDoerUserIds: readonly string[];
  /** `null`: not an active member, or a kind that cannot be read. */
  readonly kindOf: (userId: string) => MembershipKind | null;
  readonly assignerUserId: string;
  /** The request names the supervisors (a `[]` included): the caller chose them. */
  readonly supervisorsNamed: boolean;
}

/** What the rules found that needs facts or a write; `null` when no AI employee is involved. */
export interface AiPeoplePlan {
  readonly aiDoerUserId: string;
  readonly isNew: boolean;
  /** The assigner, when no person supervises and the request left the supervisors alone. */
  readonly defaultSupervisorUserId: string | null;
}

export const AI_PEOPLE_CAUSE = {
  supervisor: 'ai_employee:cannot_supervise',
  watcher: 'ai_employee:cannot_watch',
  oneOpen: 'ai_employee:one_open_assignment',
  needsSupervisor: 'ai_employee:needs_supervisor',
  assigner: 'ai_employee:assigner_not_person',
  notAllowed: 'ai_employee:assign_not_allowed',
  policy: 'ai_employee:assign_policy',
  workspaceOff: 'ai_employee:workspace_off',
  notActive: 'ai_employee:not_active',
  notOnProject: 'ai_employee:not_on_project',
  projectClosed: 'ai_employee:project_closed',
} as const;

function badRequest(cause: string, field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field, message }], cause);
}
function conflict(cause: string, message: string): ApiError {
  return new ApiError(409, 'conflict', message, undefined, cause);
}
function forbidden(cause: string, message: string): ApiError {
  return new ApiError(403, 'forbidden', message, undefined, cause);
}

/** The pure half: the shape rules (1, 2, 4) and what is left to decide. Throws on a refusal. */
export function planAiPeople(question: AiPeopleQuestion): AiPeoplePlan | null {
  const { after, kindOf } = question;
  if (after.supervisorUserIds.some((id) => kindOf(id) === 'ai')) {
    throw badRequest(
      AI_PEOPLE_CAUSE.supervisor,
      'supervisorUserIds',
      'AI employees can’t supervise. Choose a person.',
    );
  }
  if (after.watcherUserIds.some((id) => kindOf(id) === 'ai')) {
    throw badRequest(
      AI_PEOPLE_CAUSE.watcher,
      'watcherUserIds',
      'AI employees can’t watch work. Make him a doer instead.',
    );
  }
  const aiDoers = after.doerUserIds.filter((id) => kindOf(id) === 'ai');
  if (aiDoers.length === 0) return null;
  if (aiDoers.length > 1) {
    throw conflict(AI_PEOPLE_CAUSE.oneOpen, 'A task can have only one AI employee doing it.');
  }
  const aiDoerUserId = aiDoers[0] as string;
  const supervised = after.supervisorUserIds.some((id) => kindOf(id) === 'human');
  let defaultSupervisorUserId: string | null = null;
  if (!supervised) {
    if (question.supervisorsNamed || kindOf(question.assignerUserId) !== 'human') {
      throw conflict(
        AI_PEOPLE_CAUSE.needsSupervisor,
        'An AI employee’s work needs a person who supervises it. Choose a person.',
      );
    }
    defaultSupervisorUserId = question.assignerUserId;
  }
  return {
    aiDoerUserId,
    isNew: !question.baselineDoerUserIds.includes(aiDoerUserId),
    defaultSupervisorUserId,
  };
}

/** Who may give work to an AI employee (rule 3, the assigner half): the refusal, or `null`. */
export function assignAiRefusal(input: {
  readonly principal: Principal | undefined;
  readonly assignerKind: MembershipKind | null;
  readonly assignerIsAgent: boolean;
  readonly row: Pick<WorkItemRow, 'organizationId' | 'projectId' | 'audience' | 'state'>;
  readonly assignPolicy: AiAssignFacts['settings']['assignPolicy'];
}): ApiError | null {
  if (input.assignerIsAgent || !mayPassDoor(input.assignerKind, 'assigner')) {
    return forbidden(AI_PEOPLE_CAUSE.assigner, 'Only a person can give work to an AI employee.');
  }
  const principal = input.principal;
  if (
    principal === undefined ||
    !authorize({
      principal,
      capability: 'ai_employee.assign',
      resource: {
        organizationId: input.row.organizationId,
        projectId: input.row.projectId,
        audience: input.row.audience,
        lifecycle: input.row.state === 'archived' ? 'archived' : 'active',
      },
    }).allowed
  ) {
    return forbidden(AI_PEOPLE_CAUSE.notAllowed, 'You can’t give work to AI employees.');
  }
  if (
    input.assignPolicy === 'owners_and_admins' &&
    principal.role !== 'owner' &&
    principal.role !== 'org_admin'
  ) {
    return forbidden(
      AI_PEOPLE_CAUSE.policy,
      'In this workspace only owners and admins give work to AI employees.',
    );
  }
  return null;
}

/** The AI employee and the project (rule 3, the AI half). Throws on a refusal. */
export function requireAiMayTake(facts: AiAssignFacts, aiUserId: string): void {
  if (!facts.settings.enabled) {
    throw conflict(
      AI_PEOPLE_CAUSE.workspaceOff,
      'AI employees are switched off in this workspace.',
    );
  }
  const employee = facts.employees.get(aiUserId);
  if (employee === undefined || employee.status !== 'active') {
    throw conflict(AI_PEOPLE_CAUSE.notActive, 'This AI employee is paused or retired.');
  }
  if (facts.projectClosed) {
    throw conflict(AI_PEOPLE_CAUSE.projectClosed, 'This project is closed to AI employees.');
  }
  if (!employee.onProject) {
    throw conflict(AI_PEOPLE_CAUSE.notOnProject, 'This AI employee doesn’t work on this project.');
  }
}

/** What a writer hands the gate after its own writes, inside its transaction. */
export interface AiPeopleSettleInput {
  readonly principal: Principal | undefined;
  /** The item as it now is (owner and project after the write). */
  readonly row: WorkItemRow;
  readonly after: AiPeopleSnapshot;
  readonly baselineDoerUserIds: readonly string[];
  readonly supervisorsNamed: boolean;
  /** The item moved to another project in this request: re-check the AI doer it keeps. */
  readonly projectChanged: boolean;
  /** Where a defaulted supervisor is written. */
  readonly assignees: Pick<WorkItemAssigneesRepository, 'replaceRole'>;
}

/** The decisions the people read carries (AR-9), so the web never re-encodes the rules. */
export interface AiPeopleDecisions {
  /** The AI employee doing the task, or `null`. */
  readonly aiDoerUserId: string | null;
  /** An AI employee does it and no person supervises it: the screen asks for one (S7b). */
  readonly supervisorRequired: boolean;
  /** The reader may make an AI employee the doer of this task now (switches, rights, project). */
  readonly canAssignAi: boolean;
}

/** The seam the work writers call; a fake in unit tests, {@link WorkAiPeopleGate} in the app. */
export interface WorkAiPeoplePort {
  /** Refuse, or write the defaulted supervisor; answers the supervisors as they now are. */
  settle(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AiPeopleSettleInput,
  ): Promise<readonly string[]>;
  /** AR-9: what the people read tells the screen (S7b error state, the AI section). */
  decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    row: WorkItemRow,
    people: AiPeopleSnapshot,
  ): Promise<AiPeopleDecisions>;
  /** Rule 1 for the add-watchers route, which writes no other role. */
  refuseAiWatchers(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<void>;
}

export class WorkAiPeopleGate implements WorkAiPeoplePort {
  constructor(
    private readonly enabled: boolean = aiEmployeesEnabled(process.env),
    private readonly repository: Pick<
      WorkAiPeopleRepository,
      'kinds'
    > = new WorkAiPeopleRepository(),
    private readonly facts: Pick<AiAssignFactsReader, 'read'> = new AiAssignFactsReader(),
  ) {}

  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    row: WorkItemRow,
    people: AiPeopleSnapshot,
  ): Promise<AiPeopleDecisions> {
    const members = await this.repository.kinds(runner, context, [
      ...new Set([...people.doerUserIds, ...people.supervisorUserIds, context.userId]),
    ]);
    const kindOf = (userId: string) => members.get(userId)?.kind ?? null;
    const aiDoerUserId = people.doerUserIds.find((id) => kindOf(id) === 'ai') ?? null;
    const supervisorRequired =
      aiDoerUserId !== null && !people.supervisorUserIds.some((id) => kindOf(id) === 'human');
    if (!this.enabled) return { aiDoerUserId, supervisorRequired, canAssignAi: false };
    const facts = await this.facts.read(runner, context, row.projectId, []);
    const refusal = assignAiRefusal({
      principal,
      assignerKind: kindOf(context.userId),
      assignerIsAgent: context.aiEmployee !== undefined,
      row,
      assignPolicy: facts.settings.assignPolicy,
    });
    return {
      aiDoerUserId,
      supervisorRequired,
      canAssignAi: refusal === null && facts.settings.enabled && !facts.projectClosed,
    };
  }

  async refuseAiWatchers(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<void> {
    const members = await this.repository.kinds(runner, context, userIds);
    planAiPeople({
      after: { doerUserIds: [], supervisorUserIds: [], watcherUserIds: userIds },
      baselineDoerUserIds: [],
      kindOf: (userId) => members.get(userId)?.kind ?? null,
      assignerUserId: context.userId,
      supervisorsNamed: false,
    });
  }

  async settle(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AiPeopleSettleInput,
  ): Promise<readonly string[]> {
    const { after } = input;
    const named = [
      ...new Set([
        ...after.doerUserIds,
        ...after.supervisorUserIds,
        ...after.watcherUserIds,
        context.userId,
      ]),
    ];
    const members = await this.repository.kinds(runner, context, named);
    const kindOf = (userId: string) => members.get(userId)?.kind ?? null;
    const plan = planAiPeople({
      after,
      baselineDoerUserIds: input.baselineDoerUserIds,
      kindOf,
      assignerUserId: context.userId,
      supervisorsNamed: input.supervisorsNamed,
    });
    if (plan === null) return after.supervisorUserIds;

    if (plan.isNew) {
      // Phase 1: with the server switch off AI employees do not exist for anyone (the directory
      // hides them), so a new one is refused like any other person who is not a member.
      if (!this.enabled) {
        throw new ApiError(422, 'validation_failed', 'Someone is not a member', [
          { field: 'userIds', message: 'must be active members of this organization' },
        ]);
      }
    }
    if (plan.isNew || input.projectChanged) {
      const facts = await this.facts.read(runner, context, input.row.projectId, [
        plan.aiDoerUserId,
      ]);
      if (plan.isNew) {
        const refusal = assignAiRefusal({
          principal: input.principal,
          assignerKind: kindOf(context.userId),
          assignerIsAgent: context.aiEmployee !== undefined,
          row: input.row,
          assignPolicy: facts.settings.assignPolicy,
        });
        if (refusal !== null) throw refusal;
      }
      requireAiMayTake(facts, plan.aiDoerUserId);
    }

    if (plan.defaultSupervisorUserId === null) return after.supervisorUserIds;
    const supervisors = [...after.supervisorUserIds, plan.defaultSupervisorUserId];
    const membershipIds = supervisors
      .map((id) => members.get(id)?.membershipId)
      .filter((id): id is string => id !== undefined);
    await input.assignees.replaceRole(runner, context, input.row.id, 'supervisor', membershipIds);
    return supervisors.filter((id) => members.has(id));
  }
}
