import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkChecklistController } from './work-checklist.controller.js';
import { WorkChecklistService } from './work-checklist.service.js';
import type { ChecklistItemWithAssignee } from './work-checklist.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import { PortalService } from '../clients/portal.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { WorkStagesRepository } from './stages/stages.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow, WorkStageRow } from '../../common/database/schema.js';

/**
 * Work area (2026-11-23), slice W-API-3 — steps are one model (D3) and the client follows
 * progress (D5). Real controller and service, real `authorize`; in-memory repositories. The copy
 * of `work_item_subtasks` into steps (0414) and the SQL are the DB suite's.
 */

const ORG = 'org-1';
const PROJECT = 'proj-1';
const WORK = 'wi-1';
const context = { organizationId: ORG, userId: 'u-me', correlationId: 'c-1' } as TenantContext;
const owner: Principal = {
  userId: 'u-me',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-me',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: true,
};

function work(over: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: WORK,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'Brand book',
    description: null,
    state: 'in_progress',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...over,
  } as WorkItemRow;
}

function stepsHarness() {
  const rows: ChecklistItemWithAssignee[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const created: Record<string, unknown>[] = [];
  const database = {
    read: async (_c: unknown, run: (r: unknown) => Promise<unknown>) => run({}),
    transaction: async (_c: unknown, run: (t: unknown) => Promise<unknown>) => run({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === WORK ? work() : null),
  } as unknown as WorkItemsRepository;
  const members = new Map([['u-ana', 'm-ana']]);
  const checklist = {
    findItem: async (_r: unknown, _c: unknown, workItemId: string, itemId: string) =>
      rows.find((row) => row.workItemId === workItemId && row.id === itemId) ?? null,
    listForWorkItem: async (_r: unknown, _c: unknown, workItemId: string) =>
      rows.filter((row) => row.workItemId === workItemId).sort((a, b) => a.position - b.position),
    create: async (
      _r: unknown,
      _c: unknown,
      input: { workItemId: string; label: string; assigneeMembershipId?: string; dueOn?: string },
    ) => {
      const row = {
        id: `ck-${rows.length + 1}`,
        organizationId: ORG,
        workItemId: input.workItemId,
        label: input.label,
        done: false,
        position: rows.length,
        createdAt: new Date(0),
        assigneeMembershipId: input.assigneeMembershipId ?? null,
        assigneeUserId: input.assigneeMembershipId
          ? ([...members].find(([, m]) => m === input.assigneeMembershipId)?.[0] ?? null)
          : null,
        dueOn: input.dueOn ?? null,
      };
      rows.push(row);
      return row;
    },
    update: async () => null,
    delete: async (_r: unknown, _c: unknown, _w: string, itemId: string) => {
      const index = rows.findIndex((row) => row.id === itemId);
      if (index >= 0) rows.splice(index, 1);
      return index >= 0;
    },
    setPositions: async (_r: unknown, _c: unknown, _w: string, ids: readonly string[]) => {
      for (const row of rows) row.position = ids.indexOf(row.id);
    },
  };
  const assignees = {
    activeMemberships: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => members.has(id)).map((id) => [id, members.get(id)!])),
  } as unknown as WorkItemAssigneesRepository;
  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      entry: { action: string; metadata: Record<string, unknown> },
    ) => void audits.push(entry),
  } as unknown as AuditService;
  const workItemsService = {
    create: async (_c: unknown, _p: unknown, input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'wi-new', ...input };
    },
  };
  const service = new WorkChecklistService(
    database,
    workItems,
    checklist as unknown as ConstructorParameters<typeof WorkChecklistService>[2],
    workItemsService as unknown as ConstructorParameters<typeof WorkChecklistService>[3],
    audit,
    assignees,
  );
  return { controller: new WorkChecklistController(service), rows, audits, created };
}

describe('steps — one model with a person and a day (D3)', () => {
  it('a step can name a member and a day; anyone else is a 422, a bad day a 400', async () => {
    const { controller } = stepsHarness();
    const step = await controller.add(context, owner, WORK, {
      label: 'Pick the fonts',
      assigneeUserId: 'u-ana',
      dueOn: '2026-12-01',
    });
    expect(step).toMatchObject({ assigneeUserId: 'u-ana', dueOn: '2026-12-01', done: false });
    await expect(
      controller.add(context, owner, WORK, { label: 'X', assigneeUserId: 'u-stranger' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      controller.add(context, owner, WORK, { label: 'X', dueOn: '2026-02-30' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('deletes a step (audited), and another work’s step id is a 404', async () => {
    const { controller, rows, audits } = stepsHarness();
    const step = await controller.add(context, owner, WORK, { label: 'Draft' });
    await expect(controller.remove(context, owner, 'wi-other', step.id)).rejects.toMatchObject({
      status: 404,
    });
    await controller.remove(context, owner, WORK, step.id);
    expect(rows).toHaveLength(0);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'work_item.step_deleted',
        metadata: { step_id: step.id, was_done: false },
      }),
    ]);
  });

  it('reorders only with every step once', async () => {
    const { controller, audits } = stepsHarness();
    const a = await controller.add(context, owner, WORK, { label: 'A' });
    const b = await controller.add(context, owner, WORK, { label: 'B' });
    await expect(
      controller.reorder(context, owner, WORK, { itemIds: [b.id] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.reorder(context, owner, WORK, { itemIds: [b.id, b.id] }),
    ).rejects.toMatchObject({ status: 400 });
    const { items } = await controller.reorder(context, owner, WORK, { itemIds: [b.id, a.id] });
    expect(items.map((item) => item.label)).toEqual(['B', 'A']);
    expect(audits.at(-1)).toMatchObject({
      action: 'work_item.steps_reordered',
      metadata: { steps: 2 },
    });
  });

  it('turns a step into a work in the same project, then removes the step (audited)', async () => {
    const { controller, rows, audits, created } = stepsHarness();
    const step = await controller.add(context, owner, WORK, {
      label: 'Write the tone of voice page',
      assigneeUserId: 'u-ana',
      dueOn: '2026-12-05',
    });
    const made = await controller.convert(context, owner, WORK, step.id);
    expect(made.id).toBe('wi-new');
    expect(created).toEqual([
      {
        projectId: PROJECT,
        title: 'Write the tone of voice page',
        ownerUserId: 'u-ana',
        dueAt: new Date('2026-12-05T00:00:00.000Z'),
      },
    ]);
    expect(rows).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'work_item.step_converted',
      metadata: { step_id: step.id, new_work_item_id: 'wi-new' },
    });
  });
});

// ── the client follows progress (D5) ────────────────────────────────────────

const CLIENT_ORG = 'client-org-1';
const client: Principal = {
  userId: 'u-client',
  organizationId: ORG,
  kind: 'client',
  role: 'client_member',
  membershipId: 'cm-1',
  membershipStatus: 'active',
  clientOrganizationId: CLIENT_ORG,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
} as Principal;

function portalHarness(rows: WorkItemRow[]) {
  const database = {
    read: async (_c: unknown, run: (r: unknown) => Promise<unknown>) => run({}),
    transaction: async (_c: unknown, run: (t: unknown) => Promise<unknown>) => run({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      rows.find((row) => row.id === id) ?? null,
    list: async (_r: unknown, _c: unknown, options: { audiences?: readonly string[] }) =>
      rows.filter((row) => !options.audiences || options.audiences.includes(row.audience)),
  } as unknown as WorkItemsRepository;
  const stage = (id: string, name: string, stateKey: string, position: number): WorkStageRow => ({
    id,
    organizationId: ORG,
    stageSetId: 'set-1',
    name,
    stateKey,
    colorKey: null,
    position,
    createdAt: new Date(0),
  });
  const set = {
    set: { id: 'set-1', defaultMarker: null, projectId: PROJECT },
    stages: [
      stage('s1', 'Brief', 'ready', 0),
      stage('s2', 'Concept', 'in_progress', 1),
      stage('s3', 'Delivered', 'done', 2),
    ],
  };
  const stages = {
    effectiveForMany: async (_r: unknown, _c: unknown, works: readonly { id: string }[]) =>
      new Map(works.map((w) => [w.id, { source: 'project', set }])),
  } as unknown as WorkStagesRepository;
  const steps = {
    countsFor: async () => new Map([['wi-client', { done: 2, total: 5 }]]),
  };
  const service = new PortalService(
    database,
    {} as unknown as ProjectsRepository,
    workItems,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    stages,
    steps,
  );
  return { service };
}

describe('the client follows progress (D5)', () => {
  const visible = work({ id: 'wi-client', audience: 'client_visible', state: 'in_progress' });
  const internal = work({ id: 'wi-internal', audience: 'internal' });

  it('one work as the client sees it: stage, group, step counts — and nothing else', async () => {
    const { service } = portalHarness([visible, internal]);
    const view = await service.workItemFor(context, client, 'wi-client');
    expect(view).toEqual({
      id: 'wi-client',
      projectId: PROJECT,
      title: 'Brand book',
      progress: 'in_progress',
      dueAt: null,
      updatedAt: new Date(0).toISOString(),
      stageName: 'Concept',
      stageGroup: 'in_progress',
      stepsDone: 2,
      stepsTotal: 5,
    });
  });

  it('an internal, deleted, unknown or other-project work is the same 404', async () => {
    const deleted = work({ id: 'wi-gone', audience: 'client_visible', deletedAt: new Date(0) });
    const elsewhere = work({ id: 'wi-else', audience: 'client_visible', projectId: 'proj-2' });
    const { service } = portalHarness([visible, internal, deleted, elsewhere]);
    for (const id of ['wi-internal', 'wi-gone', 'wi-else', 'wi-none']) {
      await expect(service.workItemFor(context, client, id)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('the list carries the same progress fields and never an internal work', async () => {
    const { service } = portalHarness([visible, internal]);
    const list = await service.workItemsFor(context, client);
    expect(list.map((item) => item.id)).toEqual(['wi-client']);
    expect(list[0]).toMatchObject({ stageName: 'Concept', stepsDone: 2, stepsTotal: 5 });
  });
});
