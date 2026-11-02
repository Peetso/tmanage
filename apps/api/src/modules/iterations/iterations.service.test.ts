import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { IterationRow, WorkItemPlanningRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { IterationsService } from './iterations.service.js';
import type { IterationsServiceOptions } from './iterations.service.js';
import { applyWorkItemPlanning } from './work-item-planning.js';
import type { WorkItemPlanningRepository } from './work-item-planning.js';

/** 53-21 — iteration rules over an in-memory repository and the real `authorize` (INT-53-41). */

const ORG = '01890000-0000-7000-8000-00000000000a';
const P1 = '01890000-0000-7000-8000-000000000101';
const P2 = '01890000-0000-7000-8000-000000000102';
const context = { organizationId: ORG, userId: 'u1', membershipId: 'm1' } as TenantContext;
const principal: Principal = {
  userId: 'u1',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [P1, P2],
  hasOrgWideScope: true,
};

function iteration(id: string, projectId = P1, status = 'planned'): IterationRow {
  return {
    id,
    organizationId: ORG,
    projectId,
    name: id,
    goal: null,
    startsOn: '2026-11-01',
    endsOn: '2026-11-12',
    status,
    completedAt: null,
    movedCount: null,
    leftCount: null,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
}

function item(
  id: string,
  state: string,
  iterationId: string | null,
  projectId = P1,
): WorkItemPlanningRow {
  return {
    id,
    organizationId: ORG,
    projectId,
    title: id,
    state,
    audience: 'internal',
    completedAt: null,
    deletedAt: null,
    iterationId,
    points: 3,
    iterationAssignedAt: null,
  };
}

function harness() {
  const iterations = new Map<string, IterationRow>([
    ['it1', iteration('it1')],
    ['it2', iteration('it2')],
    ['done', iteration('done', P1, 'completed')],
  ]);
  const items = new Map<string, WorkItemPlanningRow>(
    [
      item('a', 'in_progress', 'it1'),
      item('b', 'done', 'it1'),
      item('c', 'blocked', 'it1'),
      item('x', 'ready', null, P2),
    ].map((row) => [row.id, row]),
  );
  const audits: string[] = [];
  const pointsOn = new Map<string, boolean>([
    [P1, false],
    [P2, false],
  ]);
  const repository: IterationsServiceOptions['repository'] & WorkItemPlanningRepository = {
    projectPoints: async (_r, _c, id) =>
      pointsOn.has(id) ? { pointsEnabled: pointsOn.get(id) === true } : null,
    setPointsEnabled: async (_r, _c, id, on) => void pointsOn.set(id, on),
    listForProject: async (_r, _c, projectId) =>
      [...iterations.values()].filter((row) => row.projectId === projectId),
    countForProject: async (_r, _c, projectId) =>
      [...iterations.values()].filter((row) => row.projectId === projectId).length,
    findById: async (_r, _c, id) => iterations.get(id) ?? null,
    insert: async () => 'new',
    update: async () => 1,
    claimCompletion: async (_r, _c, id, at) => {
      const row = iterations.get(id);
      if (!row || row.status === 'completed') return 0;
      iterations.set(id, { ...row, status: 'completed', completedAt: at });
      return 1;
    },
    recordCompletionCounts: async (_r, _c, id, moved, left) => {
      const row = iterations.get(id);
      if (row) iterations.set(id, { ...row, movedCount: moved, leftCount: left });
    },
    totals: async () => new Map(),
    itemsOf: async (_r, _c, projectId, id) =>
      [...items.values()].filter((row) => row.iterationId === id && row.projectId === projectId),
    findItems: async (_r, _c, ids) => ids.flatMap((id) => (items.has(id) ? [items.get(id)!] : [])),
    assignItems: async (_r, _c, ids, iterationId) => {
      for (const id of ids) {
        const row = items.get(id);
        if (row) items.set(id, { ...row, iterationId });
      }
      return ids.length;
    },
    setPoints: async (_r, _c, id, points) => {
      const row = items.get(id);
      if (row) items.set(id, { ...row, points });
    },
  };
  const service = new IterationsService({
    database: {
      read: (_c, f) => f({} as never),
      transaction: (_c, f) => f({} as never),
    } as IterationsServiceOptions['database'],
    repository,
    calendars: { calendarFor: async () => defaultWorkingCalendar('Asia/Riyadh') },
    audit: {
      record: async (_t, _c, input) => {
        audits.push(input.action);
        return {} as never;
      },
    },
    now: () => new Date('2026-11-03T08:00:00Z'),
  });
  return { service, items, iterations, audits, pointsOn, repository };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    const e = error as { status?: number; details?: { message: string }[] };
    return `${String(e.status)} ${e.details?.[0]?.message ?? ''}`.trim();
  }
}

describe('complete-and-roll (INT-53-41)', () => {
  it('moves only unfinished items to the target and is idempotent', async () => {
    const h = harness();
    const first = await h.service.complete(context, principal, 'it1', { moveUnfinishedTo: 'it2' });
    expect(first).toMatchObject({ moved: 2, left: 1, alreadyCompleted: false });
    expect(h.items.get('a')?.iterationId).toBe('it2');
    expect(h.items.get('c')?.iterationId).toBe('it2');
    expect(h.items.get('b')?.iterationId).toBe('it1');

    const again = await h.service.complete(context, principal, 'it1', { moveUnfinishedTo: null });
    expect(again).toMatchObject({ moved: 2, left: 1, alreadyCompleted: true });
    expect(h.items.get('a')?.iterationId).toBe('it2');
    expect(h.audits.filter((a) => a === 'iteration.completed')).toHaveLength(1);
  });

  it('refuses a completed or foreign target', async () => {
    const h = harness();
    expect(
      await failure(h.service.complete(context, principal, 'it1', { moveUnfinishedTo: 'done' })),
    ).toBe('422 invalid_target');
    expect(h.iterations.get('it1')?.status).toBe('planned');
  });
});

describe('items in/out and points', () => {
  it('refuses a cross-project add with 422 and writes nothing', async () => {
    const h = harness();
    expect(await failure(h.service.moveItems(context, principal, 'it2', { add: ['a', 'x'] }))).toBe(
      '422 cross_project',
    );
    expect(h.items.get('a')?.iterationId).toBe('it1');
  });

  it('moves same-project items and audits counts only', async () => {
    const h = harness();
    const result = await h.service.moveItems(context, principal, 'it2', { add: ['a'], remove: [] });
    expect(result).toEqual({ added: 1, removed: 0 });
    expect(h.audits).toEqual(['iteration.items_moved']);
  });

  it('refuses points while the project has them off, accepts them once on', async () => {
    const h = harness();
    const row = { id: 'a', projectId: P1 };
    expect(
      await failure(applyWorkItemPlanning({} as never, context, row, { points: 5 }, h.repository)),
    ).toBe('422 points_disabled');
    await h.service.setPointsEnabled(context, principal, P1, { pointsEnabled: true });
    const ok = await applyWorkItemPlanning({} as never, context, row, { points: 5 }, h.repository);
    expect(ok).toEqual({ points: 5, iterationId: 'it1' });
  });

  it('hides iterations from a client principal (404)', async () => {
    const h = harness();
    const client: Principal = { ...principal, kind: 'client', role: 'client_reviewer' };
    expect(await failure(h.service.get(context, client, 'it1'))).toBe('404');
  });
});
