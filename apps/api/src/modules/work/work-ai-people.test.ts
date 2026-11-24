import { describe, expect, it } from 'vitest';
import type { MembershipKind, Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { AiAssignFacts } from '../ai-employees/work-assign-facts.repository.js';
import { applyPeopleChange, WorkItemPeopleService } from './work-item-people.service.js';
import type { PeopleWritePorts } from './work-item-people.service.js';
import {
  AI_PEOPLE_CAUSE,
  assignAiRefusal,
  planAiPeople,
  WorkAiPeopleGate,
} from './work-ai-people.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { WorkWatchersRepository } from './watchers.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';

/**
 * 60-08 (plan 60 v2 §2.2 step 5, §4.6, §4.7) — the AI-employee rules on a work's people: every
 * rule and every refusal, through the real gate and the one people writer, on in-memory ports.
 */

const ORG = 'org-1';
const PROJECT = 'p-1';
const ME = 'u-me'; // a person, the assigner
const MAT = 'u-mat'; // an AI employee
const NOUR = 'u-nour'; // another AI employee
const SARA = 'u-sara'; // a person
const KINDS: Record<string, MembershipKind> = {
  [ME]: 'human',
  [SARA]: 'human',
  'u-laila': 'human',
  [MAT]: 'ai',
  [NOUR]: 'ai',
};
const context = { organizationId: ORG, userId: ME, correlationId: 'c-1' } as TenantContext;

function principal(role: string, projectIds: readonly string[] = [PROJECT]): Principal {
  return {
    userId: ME,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-u-me',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
  } as Principal;
}
const OWNER = principal('owner');
const MANAGER = principal('manager');
const MEMBER = principal('member');

const row = {
  id: 'wi-1',
  organizationId: ORG,
  projectId: PROJECT,
  audience: 'internal',
  state: 'in_progress',
  ownerUserId: null,
  version: 1,
  deletedAt: null,
} as unknown as WorkItemRow;

function facts(
  over: Partial<{
    enabled: boolean;
    assignPolicy: 'managers' | 'owners_and_admins';
    projectClosed: boolean;
    status: 'active' | 'paused' | 'retired';
    onProject: boolean;
  }> = {},
): AiAssignFacts {
  return {
    settings: {
      enabled: over.enabled ?? true,
      assignPolicy: over.assignPolicy ?? 'managers',
    },
    projectClosed: over.projectClosed ?? false,
    employees: new Map(
      [MAT, NOUR].map((userId) => [
        userId,
        { userId, status: over.status ?? 'active', onProject: over.onProject ?? true },
      ]),
    ),
  };
}

function harness(options: { readonly enabled?: boolean; facts?: AiAssignFacts } = {}) {
  const roles = new Map<string, string[]>([
    ['doer', []],
    ['supervisor', []],
  ]);
  const watching: string[] = [];
  const owner = { value: null as string | null };
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const kinds = async (_r: unknown, _c: unknown, ids: readonly string[]) =>
    new Map(
      ids
        .filter((id) => KINDS[id] !== undefined)
        .map((id) => [id, { membershipId: `m-${id}`, kind: KINDS[id] as MembershipKind }]),
    );
  const gate = new WorkAiPeopleGate(
    options.enabled ?? true,
    { kinds },
    { read: async () => options.facts ?? facts() },
  );
  const assignees = {
    activeMemberships: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => KINDS[id] !== undefined).map((id) => [id, `m-${id}`])),
    list: async () => [
      ...(roles.get('doer') ?? []).map((userId) => ({ userId, role: 'doer' })),
      ...(roles.get('supervisor') ?? []).map((userId) => ({ userId, role: 'supervisor' })),
    ],
    watcherUserIds: async () => [...watching],
    replaceRole: async (
      _r: unknown,
      _c: unknown,
      _id: string,
      role: string,
      membershipIds: readonly string[],
    ) =>
      void roles.set(
        role,
        membershipIds.map((m) => m.replace(/^m-/, '')),
      ),
    setLead: async (_r: unknown, _c: unknown, _id: string, lead: string | null) =>
      void (owner.value = lead),
  } as unknown as WorkItemAssigneesRepository;
  const watchers = {
    create: async (_r: unknown, _c: unknown, input: { memberId: string }) =>
      void watching.push(input.memberId.replace(/^m-/, '')),
    deleteForMember: async () => undefined,
    findForMember: async () => null,
  } as unknown as WorkWatchersRepository;
  const ports: PeopleWritePorts = {
    assignees,
    watchers,
    ai: gate,
    audit: {
      record: async (_r: unknown, _c: unknown, entry: unknown) =>
        void audits.push(entry as { action: string; metadata: Record<string, unknown> }),
    } as PeopleWritePorts['audit'] & object,
  };
  const change = (
    requested: Parameters<typeof applyPeopleChange>[4],
    who: Principal | 'none' = OWNER,
    extra: { creating?: boolean; projectChanged?: boolean; ctx?: TenantContext } = {},
  ) =>
    applyPeopleChange(
      {} as never,
      extra.ctx ?? context,
      ports,
      { ...row, ownerUserId: owner.value },
      requested,
      {
        ...(who === 'none' ? {} : { principal: who }),
        ...(extra.creating === undefined ? {} : { creating: extra.creating }),
        ...(extra.projectChanged === undefined ? {} : { projectChanged: extra.projectChanged }),
      },
    );
  const db = {
    read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
  } as unknown as TenantDatabase;
  const service = new WorkItemPeopleService(
    db,
    {
      findById: async () => ({ ...row, ownerUserId: owner.value }),
    } as unknown as WorkItemsRepository,
    undefined,
    assignees,
    watchers,
    undefined,
    gate,
  );
  return { roles, watching, audits, change, gate, service };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ status: number; cause: unknown }> {
  try {
    await work();
  } catch (error) {
    const e = error as { status: number; auditCode?: unknown };
    return { status: e.status, cause: e.auditCode };
  }
  throw new Error('expected a refusal');
}

describe('60-08: an AI doer always has a person supervising (plan §2.2 step 5)', () => {
  it('defaults the supervisor to the person who assigns, and audits it with the change', async () => {
    const h = harness();
    const view = await h.change({ doerUserIds: [MAT] });
    expect(view.doerUserIds).toEqual([MAT]);
    expect(view.supervisorUserIds).toEqual([ME]);
    expect(h.roles.get('supervisor')).toEqual([ME]);
    expect(h.audits[0]?.metadata).toMatchObject({ supervisors_before: 0, supervisors_after: 1 });
  });

  it('keeps a person already supervising and adds nobody', async () => {
    const h = harness();
    await h.change({ supervisorUserIds: [SARA] });
    const view = await h.change({ doerUserIds: [MAT] });
    expect(view.supervisorUserIds).toEqual([SARA]);
  });

  it('lets people share the task with one AI employee', async () => {
    const h = harness();
    const view = await h.change({ doerUserIds: [SARA, MAT] });
    expect(view.doerUserIds).toEqual([SARA, MAT]);
  });

  it('refuses removing the last person supervising while the AI employee stays (409)', async () => {
    const h = harness();
    await h.change({ doerUserIds: [MAT] });
    expect(await causeOf(() => h.change({ supervisorUserIds: [] }))).toEqual({
      status: 409,
      cause: AI_PEOPLE_CAUSE.needsSupervisor,
    });
  });

  it('refuses naming no person in the same request that adds the AI employee (409)', async () => {
    const h = harness();
    expect(
      await causeOf(() => h.change({ doerUserIds: [MAT], supervisorUserIds: [] })),
    ).toMatchObject({ status: 409, cause: AI_PEOPLE_CAUSE.needsSupervisor });
  });

  it('a person may become the supervisor in place of another', async () => {
    const h = harness();
    await h.change({ doerUserIds: [MAT] });
    const view = await h.change({ supervisorUserIds: [SARA] });
    expect(view.supervisorUserIds).toEqual([SARA]);
  });
});

describe('60-08: an AI employee never supervises or watches (§4.7)', () => {
  it('refuses an AI supervisor, also when an AI principal asks (400)', async () => {
    const h = harness();
    expect(await causeOf(() => h.change({ supervisorUserIds: [MAT] }))).toEqual({
      status: 400,
      cause: AI_PEOPLE_CAUSE.supervisor,
    });
    const agent = { ...context, userId: MAT, aiEmployee: { aiEmployeeId: 'ai-1' } } as never;
    expect(
      await causeOf(() => h.change({ supervisorUserIds: [MAT] }, OWNER, { ctx: agent })),
    ).toMatchObject({ status: 400, cause: AI_PEOPLE_CAUSE.supervisor });
    // The refusal throws inside the people write's transaction, so nothing it wrote is kept.
  });

  it('refuses an AI watcher on the people writer and the add-watchers route (400)', async () => {
    const h = harness();
    expect(await causeOf(() => h.change({ watcherUserIds: [MAT] }))).toMatchObject({
      status: 400,
      cause: AI_PEOPLE_CAUSE.watcher,
    });
    expect(await causeOf(() => h.service.addWatchers(context, OWNER, 'wi-1', [MAT]))).toMatchObject(
      { status: 400, cause: AI_PEOPLE_CAUSE.watcher },
    );
  });
});

describe('60-08: one open AI assignment per task', () => {
  it('refuses a second AI doer (409)', async () => {
    const h = harness();
    expect(await causeOf(() => h.change({ doerUserIds: [MAT, NOUR] }))).toEqual({
      status: 409,
      cause: AI_PEOPLE_CAUSE.oneOpen,
    });
  });
});

describe('60-08: who may give work to an AI employee (§4.6, S8 policy)', () => {
  it('needs ai_employee.assign: a member is refused, a manager on the project passes (403)', async () => {
    expect(await causeOf(() => harness().change({ doerUserIds: [MAT] }, MEMBER))).toEqual({
      status: 403,
      cause: AI_PEOPLE_CAUSE.notAllowed,
    });
    const view = await harness().change({ doerUserIds: [MAT] }, MANAGER);
    expect(view.doerUserIds).toEqual([MAT]);
  });

  it('no principal is a refusal (fail closed)', async () => {
    expect(await causeOf(() => harness().change({ doerUserIds: [MAT] }, 'none'))).toMatchObject({
      status: 403,
    });
  });

  it('"owners and admins" policy refuses a manager but lets the owner assign', async () => {
    const strict = facts({ assignPolicy: 'owners_and_admins' });
    expect(
      await causeOf(() => harness({ facts: strict }).change({ doerUserIds: [MAT] }, MANAGER)),
    ).toEqual({ status: 403, cause: AI_PEOPLE_CAUSE.policy });
    const view = await harness({ facts: strict }).change({ doerUserIds: [MAT] }, OWNER);
    expect(view.doerUserIds).toEqual([MAT]);
  });

  it('an AI employee can never assign work to an AI employee (door assigner)', () => {
    const refusal = assignAiRefusal({
      principal: OWNER,
      assignerKind: 'ai',
      assignerIsAgent: true,
      row,
      assignPolicy: 'managers',
    });
    expect(refusal).toMatchObject({ status: 403, auditCode: AI_PEOPLE_CAUSE.assigner });
  });
});

describe('60-08: the AI employee and the project', () => {
  it.each([
    [{ enabled: false }, AI_PEOPLE_CAUSE.workspaceOff],
    [{ status: 'paused' as const }, AI_PEOPLE_CAUSE.notActive],
    [{ status: 'retired' as const }, AI_PEOPLE_CAUSE.notActive],
    [{ projectClosed: true }, AI_PEOPLE_CAUSE.projectClosed],
    [{ onProject: false }, AI_PEOPLE_CAUSE.notOnProject],
  ])('refuses %o with 409', async (over, cause) => {
    const h = harness({ facts: facts(over) });
    expect(await causeOf(() => h.change({ doerUserIds: [MAT] }))).toEqual({ status: 409, cause });
    expect(h.roles.get('supervisor')).toEqual([]);
  });

  it('a new item counts its AI lead as a new assignment (rules run on create)', async () => {
    const h = harness({ facts: facts({ status: 'paused' }) });
    expect(
      await causeOf(() => h.change({ doerUserIds: [MAT] }, OWNER, { creating: true })),
    ).toMatchObject({ status: 409, cause: AI_PEOPLE_CAUSE.notActive });
  });

  it('a move re-checks the project for the AI doer kept', async () => {
    const options: { facts?: AiAssignFacts } = {};
    const h = harness(options);
    await h.change({ doerUserIds: [MAT] });
    options.facts = facts({ onProject: false });
    expect(
      await causeOf(() => h.change({ watcherUserIds: [] }, OWNER, { projectChanged: true })),
    ).toEqual({ status: 409, cause: AI_PEOPLE_CAUSE.notOnProject });
    // Without a move the kept AI doer is not re-checked: other edits still work.
    const view = await h.change({ watcherUserIds: [SARA] });
    expect(view.watcherUserIds).toEqual([SARA]);
  });

  it('with the server switch off a new AI doer is not a member (422) and existing work still edits', async () => {
    const h = harness({ enabled: false });
    expect(await causeOf(() => h.change({ doerUserIds: [MAT] }))).toMatchObject({ status: 422 });
    const view = await h.change({ doerUserIds: [SARA] });
    expect(view.doerUserIds).toEqual([SARA]);
  });

  it('not connected is not a refusal (the picker shows it; the queue waits)', () => {
    // Connection is not part of AiAssignFacts at all: nothing to refuse on.
    expect(Object.keys(facts())).toEqual(['settings', 'projectClosed', 'employees']);
  });
});

describe('60-08: the decisions on the people read (AR-9)', () => {
  it('names the AI doer, asks for a supervisor, and says whether the reader may assign AI', async () => {
    const h = harness();
    const people = { doerUserIds: [MAT], supervisorUserIds: [], watcherUserIds: [] };
    expect(await h.gate.decide({} as never, context, MANAGER, row, people)).toEqual({
      aiDoerUserId: MAT,
      supervisorRequired: true,
      canAssignAi: true,
    });
    expect(await h.gate.decide({} as never, context, MEMBER, row, people)).toMatchObject({
      canAssignAi: false,
    });
    const off = harness({ enabled: false });
    expect(await off.gate.decide({} as never, context, OWNER, row, people)).toMatchObject({
      canAssignAi: false,
    });
  });

  it('the pure plan answers null when no AI employee is involved', () => {
    expect(
      planAiPeople({
        after: { doerUserIds: [SARA], supervisorUserIds: [], watcherUserIds: [] },
        baselineDoerUserIds: [],
        kindOf: (id) => KINDS[id] ?? null,
        assignerUserId: ME,
        supervisorsNamed: false,
      }),
    ).toBeNull();
  });
});
