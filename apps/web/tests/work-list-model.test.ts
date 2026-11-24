import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  activeRailView,
  ageOf,
  applyLoadedFilters,
  matchesDue,
  parseWorkListParams,
  railCounts,
  railSelection,
  railViewFilters,
  workListQuery,
} from '../src/components/work/list/work-list-model';
import { stageColumnOf } from '../src/components/screens/WorkBoardView';
import type { WorkItemSummary } from '../src/lib/api/work-items';

/** Work area v2 (W-WEB-2): the Works list's filters, rail views, counts and the board's columns. */
function item(id: string, overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id,
    projectId: 'p1',
    type: 'task',
    title: id,
    description: null,
    state: 'ready',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const TODAY = '2026-11-23';

describe('Works list filters in the address (I-1)', () => {
  it('round-trips every filter and leaves defaults out', () => {
    const filters = {
      projectId: 'p1',
      states: ['in_progress', 'blocked'] as const,
      stageIds: ['st-a'],
      doer: 'me',
      teamId: 't1',
      due: 'week' as const,
    };
    const query = workListQuery({ view: 'board', filters });
    expect(query).toBe(
      '?project=p1&state=in_progress%2Cblocked&stage=st-a&doer=me&team=t1&due=week&view=board',
    );
    expect(parseWorkListParams(new URLSearchParams(query))).toEqual(filters);
    expect(workListQuery({ view: 'list', filters: NO_FILTERS })).toBe('');
  });

  it('drops what it does not know rather than guessing', () => {
    const parsed = parseWorkListParams(new URLSearchParams('state=nope,done&due=someday'));
    expect(parsed.states).toEqual(['done']);
    expect(parsed.due).toBe('any');
  });
});

describe('filters on the loaded rows', () => {
  const rows = [
    item('a', { doerUserIds: ['u1', 'u2'], stageId: 's1', dueAt: '2026-11-25T12:00:00Z' }),
    item('b', { doerUserIds: ['u2'], stageId: 's2', dueAt: '2026-11-20T12:00:00Z' }),
    item('c', { ownerUserId: 'u1' }),
  ];
  const context = { today: TODAY, viewerUserId: 'u1' };

  it('finds every doer, not only the lead, and reads "me" as the reader', () => {
    const mine = applyLoadedFilters(rows, { ...NO_FILTERS, doer: 'me' }, context).map((r) => r.id);
    expect(mine).toEqual(['a', 'c']);
    expect(
      applyLoadedFilters(rows, { ...NO_FILTERS, doer: 'u2' }, context).map((r) => r.id),
    ).toEqual(['a', 'b']);
    // Without a known reader, "me" matches nothing rather than everything.
    expect(
      applyLoadedFilters(rows, { ...NO_FILTERS, doer: 'me' }, { ...context, viewerUserId: null }),
    ).toEqual([]);
  });

  it('narrows by a named stage and by the due day', () => {
    expect(
      applyLoadedFilters(rows, { ...NO_FILTERS, stageIds: ['s2'] }, context).map((r) => r.id),
    ).toEqual(['b']);
    expect(
      applyLoadedFilters(rows, { ...NO_FILTERS, due: 'overdue' }, context).map((r) => r.id),
    ).toEqual(['b']);
    expect(
      applyLoadedFilters(rows, { ...NO_FILTERS, due: 'none' }, context).map((r) => r.id),
    ).toEqual(['c']);
    expect(matchesDue(item('d', { dueAt: '2026-11-29T12:00:00Z' }), 'week', TODAY)).toBe(true);
    expect(matchesDue(item('e', { dueAt: '2026-11-30T12:00:00Z' }), 'week', TODAY)).toBe(false);
    expect(
      matchesDue(item('f', { dueAt: '2026-11-01T12:00:00Z', state: 'done' }), 'overdue', TODAY),
    ).toBe(false);
  });
});

describe('rail views and counts (Figma WV2-01)', () => {
  it('each view is a set of filters that keeps the project and the team', () => {
    const current = { ...NO_FILTERS, projectId: 'p1', teamId: 't1', due: 'today' as const };
    const review = railViewFilters('review', current);
    expect(review).toEqual({
      ...NO_FILTERS,
      projectId: 'p1',
      teamId: 't1',
      states: ['internal_review'],
    });
    expect(activeRailView(review)).toBe('review');
    expect(activeRailView(current)).toBeNull();
    expect(activeRailView(railViewFilters('mine', NO_FILTERS))).toBe('mine');
  });

  it('marks one rail row only: the project, else the team, else the view (WX3 R8)', () => {
    const all = railViewFilters('all', NO_FILTERS);
    expect(railSelection(all)).toEqual({ kind: 'view', id: 'all' });
    expect(railSelection({ ...all, projectId: 'p1', teamId: 't1' })).toEqual({
      kind: 'project',
      id: 'p1',
    });
    expect(railSelection({ ...all, teamId: 't1' })).toEqual({ kind: 'team', id: 't1' });
    expect(railSelection({ ...NO_FILTERS, due: 'today' })).toBeNull();
  });

  it('counts each view, project and team from one read, archived left out', () => {
    const rows = [
      item('a', { doerUserIds: ['u1'], dueAt: '2026-11-24T12:00:00Z' }),
      item('b', { projectId: 'p2', doerUserIds: ['u2'], state: 'internal_review' }),
      item('c', { state: 'archived', doerUserIds: ['u1'] }),
    ];
    const counts = railCounts(rows, {
      today: TODAY,
      viewerUserId: 'u1',
      teamMembers: new Map([['t1', ['u2']]]),
      partial: false,
    });
    expect(counts.views).toEqual({ all: 2, mine: 1, week: 1, review: 1 });
    expect(counts.projects.get('p1')).toBe(1);
    expect(counts.projects.get('p2')).toBe(1);
    expect(counts.teams.get('t1')).toBe(1);
  });
});

describe('the Updated cell and the board columns', () => {
  it('reads the age in the unit the design shows', () => {
    const now = new Date('2026-11-23T09:00:00Z');
    expect(ageOf('2026-11-23T07:00:00Z', now)).toEqual({ value: 2, unit: 'hour' });
    expect(ageOf('2026-11-22T07:00:00Z', now)).toEqual({ value: 1, unit: 'day' });
    expect(ageOf('2026-11-16T07:00:00Z', now)).toEqual({ value: 1, unit: 'week' });
  });

  const stages = [
    {
      id: 's-e',
      name: 'Empathize',
      stateKey: 'ready',
      group: 'not_started' as const,
      colorKey: null,
      position: 0,
      workCount: 0,
    },
    {
      id: 's-p',
      name: 'Prototype',
      stateKey: 'in_progress',
      group: 'in_progress' as const,
      colorKey: null,
      position: 1,
      workCount: 0,
    },
    {
      id: 's-d',
      name: 'Done',
      stateKey: 'done',
      group: 'done' as const,
      colorKey: null,
      position: 2,
      workCount: 0,
    },
  ];

  it('puts a card on its stored stage, else the first stage of its state; archived is off', () => {
    expect(stageColumnOf(item('a', { stageId: 's-p', state: 'in_progress' }), stages)).toBe('s-p');
    expect(stageColumnOf(item('b', { state: 'backlog' }), stages)).toBe('s-e');
    expect(stageColumnOf(item('c', { state: 'blocked' }), stages)).toBe('s-p');
    expect(stageColumnOf(item('d', { state: 'archived' }), stages)).toBeNull();
  });
});
