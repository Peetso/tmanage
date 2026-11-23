import { describe, expect, it } from 'vitest';
import { workItemStateMachine } from '@tmanage/domain';
import type { Principal, WorkItemState } from '@tmanage/domain';
import {
  BUILT_IN_STAGES,
  STAGE_STATE_KEYS,
  checkSetRules,
  groupOfState,
  isPermutationOf,
  setCoversState,
  stageForWork,
  stageIdAfterTransition,
  type StageLike,
} from './stage-rules.js';
import { WorkStagesService } from './stages.service.js';
import type { StageSetWithStages, WorkStagesRepository } from './stages.repository.js';
import { WorkItemsService } from '../work-items.service.js';
import type { WorkItemsRepository } from '../work-items.repository.js';
import type { WorkItemAssigneesRepository } from '../work-item-assignees.repository.js';
import type { ProjectsRepository } from '../../projects/projects.repository.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import type { WorkItemRow, WorkStageRow } from '../../../common/database/schema.js';

/**
 * Work area D1 (2026-11-23), slice W-API-2 — renamable stages and own stage sets. The pure rules,
 * then the stages service with in-memory repositories (real `authorize`), then the work-items
 * transition hook ("transitions respect the set"). The SQL round-trip is the DB suite's.
 */

const ORG = 'org-1';
const PROJECT = 'proj-1';
const context = { organizationId: ORG, userId: 'u-me', correlationId: 'c-1' } as TenantContext;

function principal(role: string, projectIds: string[] = [PROJECT]): Principal {
  return {
    userId: 'u-me',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-me',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
  } as Principal;
}
const OWNER = principal('owner');
const MEMBER = principal('member');

const stage = (id: string, stateKey: string, position: number, name = id): StageLike => ({
  id,
  name,
  stateKey,
  position,
});

// ── the pure rules ───────────────────────────────────────────────────────────

describe('stage rules', () => {
  it('every stage state is a real state of the machine, and none is a system state', () => {
    for (const key of STAGE_STATE_KEYS) {
      expect(workItemStateMachine.allowedFrom(key as WorkItemState)).toBeDefined();
      expect(groupOfState(key)).not.toBeNull();
    }
    expect(groupOfState('blocked')).toBeNull();
    expect(groupOfState('archived')).toBeNull();
  });

  it('the built-in stages obey the set rules and cover every stage state', () => {
    expect(checkSetRules(BUILT_IN_STAGES)).toBeNull();
    for (const key of STAGE_STATE_KEYS) expect(setCoversState(BUILT_IN_STAGES, key)).toBe(true);
  });

  it('a set needs not started, in progress and exactly one done', () => {
    const base = [stage('a', 'ready', 0), stage('b', 'in_progress', 1), stage('c', 'done', 2)];
    expect(checkSetRules(base)).toBeNull();
    expect(checkSetRules(base.slice(1))?.rule).toBe('needs_not_started');
    expect(checkSetRules([base[0]!, base[2]!])?.rule).toBe('needs_in_progress');
    expect(checkSetRules(base.slice(0, 2))?.rule).toBe('needs_one_done');
    expect(checkSetRules([...base, stage('d', 'done', 3)])?.rule).toBe('needs_one_done');
  });

  it('a set without "In review" has no place for internal_review; system states always fit', () => {
    const set = [stage('a', 'ready', 0), stage('b', 'in_progress', 1), stage('c', 'done', 2)];
    expect(setCoversState(set, 'internal_review')).toBe(false);
    expect(setCoversState(set, 'backlog')).toBe(true); // the "Not started" group
    expect(setCoversState(set, 'blocked')).toBe(true);
  });

  it('a work shows its own stage only while that stage has its state', () => {
    const set = [
      stage('brief', 'ready', 0),
      stage('concept', 'in_progress', 1),
      stage('design', 'in_progress', 2),
      stage('done', 'done', 3),
    ];
    expect(stageForWork(set, 'in_progress', 'design')?.id).toBe('design');
    expect(stageForWork(set, 'in_progress', null)?.id).toBe('concept');
    expect(stageForWork(set, 'done', 'design')?.id).toBe('done');
    expect(stageForWork(set, 'backlog', null)?.id).toBe('brief'); // same group
    expect(stageForWork(set, 'blocked', 'design')).toBeNull();
    expect(stageIdAfterTransition(set, 'in_progress', 'design')).toBe('design');
    expect(stageIdAfterTransition(set, 'done', 'design')).toBeNull();
    expect(stageIdAfterTransition(set, 'done', 'design', 'done')).toBe('done');
  });

  it('a reorder must name every stage once', () => {
    const set = [stage('a', 'ready', 0), stage('b', 'done', 1)];
    expect(isPermutationOf(['b', 'a'], set)).toBe(true);
    expect(isPermutationOf(['a', 'a'], set)).toBe(false);
    expect(isPermutationOf(['a'], set)).toBe(false);
    expect(isPermutationOf(['a', 'x'], set)).toBe(false);
  });
});

// ── the stages service ───────────────────────────────────────────────────────

function stagesHarness(options: { inReview?: number; onStage?: number } = {}) {
  const sets = new Map<string, StageSetWithStages>();
  const links = new Map<string, string>();
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const repointed: { from: readonly string[]; to: string | null; scope?: unknown }[] = [];
  const calls: { kind: string; args: unknown[] }[] = [];
  let seq = 0;
  const now = new Date('2026-11-23T10:00:00.000Z');

  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (t: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const put = (id: string, patch: Partial<StageSetWithStages['set']>, stages?: WorkStageRow[]) => {
    const current = sets.get(id)!;
    sets.set(id, {
      set: { ...current.set, ...patch },
      stages: stages ?? current.stages,
    });
  };

  const repo = {
    listSets: async () => [...sets.values()],
    findSet: async (_r: unknown, _c: unknown, id: string) => sets.get(id) ?? null,
    findSetByName: async (_r: unknown, _c: unknown, name: string) =>
      [...sets.values()].find((entry) => entry.set.name === name)?.set ?? null,
    countSets: async () => sets.size,
    insertSet: async (
      _r: unknown,
      _c: unknown,
      input: {
        name: string;
        scope: string;
        projectId: string | null;
        stages: { name: string; stateKey: string; colorKey: string | null; position: number }[];
      },
    ) => {
      seq += 1;
      const id = `set-${seq}`;
      sets.set(id, {
        set: {
          id,
          organizationId: ORG,
          name: input.name,
          scope: input.scope,
          projectId: input.projectId,
          defaultMarker: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        stages: input.stages.map((s, index) => ({
          id: `${id}-s${index}`,
          organizationId: ORG,
          stageSetId: id,
          createdAt: now,
          ...s,
        })),
      });
      return id;
    },
    updateSet: async (
      _r: unknown,
      _c: unknown,
      id: string,
      version: number,
      patch: { name?: string },
    ) => {
      const current = sets.get(id)!;
      if (current.set.version !== version) return false;
      put(id, { ...patch, version: version + 1 });
      return true;
    },
    touchSet: async () => undefined,
    setDefault: async (_r: unknown, _c: unknown, id: string | null) => {
      for (const [key, entry] of sets) {
        sets.set(key, { ...entry, set: { ...entry.set, defaultMarker: key === id ? 1 : null } });
      }
    },
    defaultSet: async () =>
      [...sets.values()].find((entry) => entry.set.defaultMarker === 1) ?? null,
    deleteSet: async (_r: unknown, _c: unknown, id: string) => void sets.delete(id),
    insertStage: async (
      _r: unknown,
      _c: unknown,
      setId: string,
      s: { name: string; stateKey: string; colorKey: string | null; position: number },
    ) => {
      seq += 1;
      const id = `stg-${seq}`;
      const current = sets.get(setId)!;
      put(setId, {}, [
        ...current.stages,
        { id, organizationId: ORG, stageSetId: setId, createdAt: now, ...s },
      ]);
      return id;
    },
    updateStage: async (
      _r: unknown,
      _c: unknown,
      stageId: string,
      patch: Partial<WorkStageRow>,
    ) => {
      for (const [key, entry] of sets) {
        put(
          key,
          {},
          entry.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s)),
        );
      }
    },
    setPositions: async (_r: unknown, _c: unknown, setId: string, ids: readonly string[]) => {
      const current = sets.get(setId)!;
      put(
        setId,
        {},
        current.stages.map((s) => ({ ...s, position: ids.indexOf(s.id) })),
      );
    },
    deleteStage: async (_r: unknown, _c: unknown, stageId: string) => {
      for (const [key, entry] of sets) {
        put(
          key,
          {},
          entry.stages.filter((s) => s.id !== stageId),
        );
      }
    },
    projectSetId: async (_r: unknown, _c: unknown, projectId: string) =>
      links.get(projectId) ?? null,
    linkProject: async (_r: unknown, _c: unknown, projectId: string, setId: string | null) => {
      if (setId === null) links.delete(projectId);
      else links.set(projectId, setId);
    },
    usage: async (_r: unknown, _c: unknown, setId: string) => ({
      projects: [...links.values()].filter((id) => id === setId).length,
      works: 0,
    }),
    worksOnSetInState: async () => options.inReview ?? 0,
    projectWorksInState: async () => options.inReview ?? 0,
    effectiveFor: async () => ({ source: 'builtin', set: null }),
  } as unknown as WorkStagesRepository;

  const workItems = {
    repointStage: async (
      _r: unknown,
      _c: unknown,
      from: readonly string[],
      to: string | null,
      scope?: unknown,
    ) => {
      repointed.push({ from, to, scope });
      return from.length;
    },
    countOnStages: async () => options.onStage ?? 0,
    findById: async () => ({ id: 'wi-1', projectId: PROJECT, state: 'ready', stageSetId: null }),
  } as unknown as WorkItemsRepository;

  const workItemsService = {
    get: async () => ({ id: 'wi-1', projectId: PROJECT, state: 'ready', version: 3 }),
    transition: async (...args: unknown[]) => {
      calls.push({ kind: 'transition', args });
      return { id: 'wi-1' };
    },
    changeStage: async (...args: unknown[]) => {
      calls.push({ kind: 'changeStage', args });
      return { id: 'wi-1' };
    },
    changeStageSet: async (...args: unknown[]) => {
      calls.push({ kind: 'changeStageSet', args });
      return { id: 'wi-1' };
    },
  };

  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      entry: { action: string; metadata: Record<string, unknown> },
    ) => void audits.push(entry),
  } as unknown as AuditService;

  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === PROJECT ? { id, organizationId: ORG, archivedAt: null } : null,
  } as unknown as ProjectsRepository;

  const service = new WorkStagesService(
    database,
    workItemsService as unknown as ConstructorParameters<typeof WorkStagesService>[1],
    audit,
    repo,
    projects,
    workItems,
    () => now,
  );
  return { service, sets, links, audits, repointed, calls, repo };
}

const DESIGN_THINKING = [
  { name: 'Brief', stateKey: 'ready' },
  { name: 'Concept', stateKey: 'in_progress' },
  { name: 'Design', stateKey: 'in_progress' },
  { name: 'Client review', stateKey: 'internal_review' },
  { name: 'Delivered', stateKey: 'done' },
];

describe('WorkStagesService', () => {
  it('an owner creates a workspace set; without stages it copies the built-in ones; audited', async () => {
    const { service, audits } = stagesHarness();
    const view = await service.createSet(context, OWNER, { name: 'Agency flow' });
    expect(view.scope).toBe('custom');
    expect(view.stages.map((s) => s.stateKey)).toEqual(BUILT_IN_STAGES.map((s) => s.stateKey));
    expect(view.stages.map((s) => s.group)).toEqual([
      'not_started',
      'not_started',
      'in_progress',
      'in_review',
      'done',
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'work_stage_set.created',
        metadata: { stages: 5, is_default: false },
      }),
    ]);
  });

  it('a member may not make a workspace set (403), nor a set for a project they do not manage', async () => {
    const { service, sets } = stagesHarness();
    await expect(service.createSet(context, MEMBER, { name: 'Mine' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.createSet(context, MEMBER, { name: 'Mine', projectId: PROJECT }),
    ).rejects.toMatchObject({ status: 403 });
    expect(sets.size).toBe(0);
  });

  it('a project set belongs to the project: linked at once, its works start at the derived stage', async () => {
    const { service, links, repointed } = stagesHarness();
    const view = await service.createSet(context, OWNER, {
      name: 'Design thinking',
      projectId: PROJECT,
      stages: DESIGN_THINKING,
    });
    expect(view).toMatchObject({ scope: 'project', projectId: PROJECT, isDefault: false });
    expect(links.get(PROJECT)).toBe(view.id);
    expect(repointed.at(-1)?.scope).toEqual({ projectId: PROJECT });
    await expect(
      service.createSet(context, OWNER, { name: 'X', projectId: PROJECT, isDefault: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a set that breaks the rules (422) and duplicate names (409)', async () => {
    const { service } = stagesHarness();
    await expect(
      service.createSet(context, OWNER, {
        name: 'No done',
        stages: [
          { name: 'A', stateKey: 'ready' },
          { name: 'B', stateKey: 'in_progress' },
        ],
      }),
    ).rejects.toMatchObject({ status: 422, auditCode: 'stage_set_needs_one_done' });
    await expect(
      service.createSet(context, OWNER, {
        name: 'Blocked',
        stages: [{ name: 'A', stateKey: 'blocked' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await service.createSet(context, OWNER, { name: 'Same' });
    await expect(service.createSet(context, OWNER, { name: 'Same' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('renames a stage, adds one at a position, and reorders; each change is audited', async () => {
    const { service, audits } = stagesHarness();
    const set = await service.createSet(context, OWNER, { name: 'Flow', stages: DESIGN_THINKING });
    const concept = set.stages[1]!.id;
    const renamed = await service.updateStage(context, OWNER, set.id, concept, { name: 'Idea' });
    expect(renamed.stages[1]?.name).toBe('Idea');
    const added = await service.addStage(context, OWNER, set.id, {
      name: 'Research',
      stateKey: 'ready',
      position: 1,
    });
    expect(added.stages.map((s) => s.name)).toEqual([
      'Brief',
      'Research',
      'Idea',
      'Design',
      'Client review',
      'Delivered',
    ]);
    const ids = added.stages.map((s) => s.id).reverse();
    await expect(service.reorderStages(context, OWNER, set.id, ids.slice(1))).rejects.toMatchObject(
      { status: 400 },
    );
    const reordered = await service.reorderStages(context, OWNER, set.id, ids);
    expect(reordered.stages.map((s) => s.id)).toEqual(ids);
    expect(
      audits.filter((a) => a.action === 'work_stage_set.changed').map((a) => a.metadata['change']),
    ).toEqual(['stage_changed', 'stage_added', 'stages_reordered']);
  });

  it('will not strand works in review, nor change the state of a stage that holds works', async () => {
    const stranded = stagesHarness({ inReview: 2 });
    const set = await stranded.service.createSet(context, OWNER, {
      name: 'Flow',
      stages: DESIGN_THINKING,
    });
    const review = set.stages.find((s) => s.stateKey === 'internal_review')!.id;
    await expect(
      stranded.service.deleteStage(context, OWNER, set.id, review, undefined),
    ).rejects.toMatchObject({ status: 409, auditCode: 'stage_set_strands_review' });

    const busy = stagesHarness({ onStage: 1 });
    const other = await busy.service.createSet(context, OWNER, {
      name: 'Flow',
      stages: DESIGN_THINKING,
    });
    await expect(
      busy.service.updateStage(context, OWNER, other.id, other.stages[2]!.id, {
        stateKey: 'ready',
      }),
    ).rejects.toMatchObject({ status: 409, auditCode: 'stage_in_use' });
  });

  it('deleting a stage keeps the set rules and moves its works to a same-state stage', async () => {
    const { service, repointed } = stagesHarness();
    const set = await service.createSet(context, OWNER, { name: 'Flow', stages: DESIGN_THINKING });
    const [, concept, design, , done] = set.stages;
    await expect(
      service.deleteStage(context, OWNER, set.id, done!.id, undefined),
    ).rejects.toMatchObject({ status: 422, auditCode: 'stage_set_needs_one_done' });
    await expect(
      service.deleteStage(context, OWNER, set.id, design!.id, set.stages[0]!.id),
    ).rejects.toMatchObject({ status: 422, auditCode: 'stage_move_target_invalid' });
    const after = await service.deleteStage(context, OWNER, set.id, design!.id, concept!.id);
    expect(after.stages.map((s) => s.name)).not.toContain('Design');
    expect(repointed.at(-1)).toMatchObject({ from: [design!.id], to: concept!.id });
  });

  it('a set a project uses cannot be deleted (409); an unused one can', async () => {
    const { service } = stagesHarness();
    const shared = await service.createSet(context, OWNER, { name: 'Shared' });
    await service.setProjectSet(context, OWNER, PROJECT, shared.id);
    await expect(service.deleteSet(context, OWNER, shared.id)).rejects.toMatchObject({
      status: 409,
      auditCode: 'stage_set_in_use',
    });
    await service.setProjectSet(context, OWNER, PROJECT, null);
    await service.deleteSet(context, OWNER, shared.id);
    await expect(service.getSet(context, shared.id)).rejects.toMatchObject({ status: 404 });
  });

  it('a project falls back to the workspace default, then to the built-in stages', async () => {
    const { service } = stagesHarness();
    expect((await service.projectSet(context, OWNER, PROJECT)).source).toBe('builtin');
    const set = await service.createSet(context, OWNER, { name: 'Default', isDefault: true });
    const effective = await service.projectSet(context, OWNER, PROJECT);
    expect(effective).toMatchObject({ source: 'workspace', stageSet: { id: set.id } });
    await expect(service.projectSet(context, OWNER, 'other-tenant-project')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a stage in another state runs the transition; the same state is a stage change', async () => {
    const { service, calls } = stagesHarness();
    await service.moveWork(context, OWNER, 'wi-1', {
      stageId: 'builtin:in_progress',
      version: 3,
      facts: {},
    });
    await service.moveWork(context, OWNER, 'wi-1', {
      stageId: 'builtin:ready',
      version: 4,
      facts: {},
    });
    expect(calls.map((c) => c.kind)).toEqual(['transition', 'changeStage']);
    expect(calls[0]!.args.slice(2)).toEqual([
      'wi-1',
      3,
      'in_progress',
      {},
      { stageId: 'builtin:in_progress' },
    ]);
    await expect(
      service.moveWork(context, OWNER, 'wi-1', { stageId: 'nope', version: 3, facts: {} }),
    ).rejects.toMatchObject({ status: 422, auditCode: 'stage_not_in_stage_set' });
  });
});

// ── the transition hook in WorkItemsService ─────────────────────────────────

function transitionHarness(stages: WorkStageRow[]) {
  const row = {
    id: 'wi-1',
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'Logo',
    description: null,
    state: 'in_progress',
    ownerUserId: 'u-me',
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    stageSetId: null,
    stageId: 'stg-design',
  } as unknown as WorkItemRow;
  let current = row;
  const writes: { stageId: string | null }[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (t: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async () => current,
    requireById: async () => current,
    transitionState: async (
      _r: unknown,
      _c: unknown,
      _id: string,
      _v: number,
      to: WorkItemState,
    ) => {
      current = { ...current, state: to, version: Number(current.version) + 1 } as WorkItemRow;
      return current;
    },
    writeStageAfterTransition: async (
      _r: unknown,
      _c: unknown,
      _id: string,
      stageId: string | null,
    ) => void writes.push({ stageId }),
  } as unknown as WorkItemsRepository;
  const set: StageSetWithStages = {
    set: {
      id: 'set-1',
      organizationId: ORG,
      name: 'Flow',
      scope: 'project',
      projectId: PROJECT,
      defaultMarker: null,
      version: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    stages,
  };
  const stagesRepo = {
    effectiveFor: async () => ({ source: 'project', set }),
    effectiveForMany: async () => new Map(),
  } as unknown as WorkStagesRepository;
  const assignees = { list: async () => [] } as unknown as WorkItemAssigneesRepository;
  const service = new WorkItemsService(
    database,
    workItems,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    assignees,
    undefined,
    undefined,
    stagesRepo,
  );
  return { service, writes };
}

const row = (id: string, stateKey: string, position: number): WorkStageRow => ({
  id,
  organizationId: ORG,
  stageSetId: 'set-1',
  name: id,
  stateKey,
  colorKey: null,
  position,
  createdAt: new Date(0),
});

describe('transitions respect the set', () => {
  const noReview = [
    row('stg-brief', 'ready', 0),
    row('stg-design', 'in_progress', 1),
    row('stg-done', 'done', 2),
  ];

  it('a set without "In review" refuses a move into internal_review (422)', async () => {
    const { service, writes } = transitionHarness(noReview);
    await expect(
      service.transition(context, OWNER, 'wi-1', 3, 'internal_review', {}),
    ).rejects.toMatchObject({ status: 422, auditCode: 'state_not_in_stage_set' });
    expect(writes).toEqual([]);
  });

  it('leaving the stage’s state drops the stage; a requested stage must have the new state', async () => {
    const { service, writes } = transitionHarness(noReview);
    await service.transition(context, OWNER, 'wi-1', 3, 'ready', {});
    expect(writes).toEqual([{ stageId: null }]);
    const other = transitionHarness(noReview);
    await expect(
      other.service.transition(context, OWNER, 'wi-1', 3, 'ready', {}, { stageId: 'stg-done' }),
    ).rejects.toMatchObject({ status: 422, auditCode: 'stage_not_in_stage_set' });
    const third = transitionHarness(noReview);
    await third.service.transition(
      context,
      OWNER,
      'wi-1',
      3,
      'ready',
      {},
      { stageId: 'stg-brief' },
    );
    expect(third.writes).toEqual([{ stageId: 'stg-brief' }]);
  });
});
