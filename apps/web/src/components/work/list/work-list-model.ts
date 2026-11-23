/**
 * Work area v2 — the Works list and board (W-WEB-2): the pure rules behind the toolbar, the rail
 * and the rows (no I/O, IP-3), proved in `tests/work-list-model.test.ts`.
 *
 * Which filter runs where, and why:
 * - **Project, state and team go to the API** (`projectId`, `state`, `teamId`): they cut the set
 *   the server pages through, so "Show more" pages the right work.
 * - **Doer, due and a named stage filter the loaded rows**: the list read has no parameter for
 *   them. The footer then says how many of the loaded rows show, so a filtered page never passes
 *   for "all of it" (I-4).
 * Every filter lives in the address (I-1): a reload or a shared link reopens the same list.
 */
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import type { WorkItemSummary } from '../../../lib/api/work-items';
import { addDays, dayOf } from '../DueDatePicker';

export type WorkListView = 'list' | 'board';
export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'month' | 'none';
export const DUE_FILTERS: readonly DueFilter[] = [
  'any',
  'overdue',
  'today',
  'week',
  'month',
  'none',
];

/** The doer filter's value for "the person reading" (My work), kept as a word in the address. */
export const ME = 'me';

export interface WorkListFilters {
  /** `''` = every project. */
  readonly projectId: string;
  /** Lifecycle states, sent to the API; `[]` = every state. */
  readonly states: readonly WorkItemState[];
  /** Stage ids of the chosen project's set, applied to the loaded rows; `[]` = every stage. */
  readonly stageIds: readonly string[];
  /** A user id, {@link ME}, or `''` for anyone. */
  readonly doer: string;
  /** `''` = every team. */
  readonly teamId: string;
  readonly due: DueFilter;
}

export const NO_FILTERS: WorkListFilters = {
  projectId: '',
  states: [],
  stageIds: [],
  doer: '',
  teamId: '',
  due: 'any',
};

/** The `?state=` value, kept to states the lifecycle defines. */
export function parseStateParam(value: string | null): readonly WorkItemState[] {
  if (value === null) return [];
  return value
    .split(',')
    .filter((entry): entry is WorkItemState =>
      (WORK_ITEM_STATES as readonly string[]).includes(entry),
    );
}

function parseDue(value: string | null): DueFilter {
  return (DUE_FILTERS as readonly string[]).includes(value ?? '') ? (value as DueFilter) : 'any';
}

/** The filters an address carries. Anything unknown is dropped rather than guessed at. */
export function parseWorkListParams(params: { get(name: string): string | null }): WorkListFilters {
  const ids = (value: string | null) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && entry.length <= 64);
  return {
    projectId: params.get('project') ?? '',
    states: parseStateParam(params.get('state')),
    stageIds: ids(params.get('stage')),
    doer: params.get('doer') ?? '',
    teamId: params.get('team') ?? '',
    due: parseDue(params.get('due')),
  };
}

/**
 * The view and the filters as a query string. Defaults are left out, so the plain `/work` address
 * stays plain (2026-10-31 live test: a reload dropped the filter and came back to the list).
 */
export function workListQuery(input: {
  readonly view: WorkListView;
  readonly filters: WorkListFilters;
}): string {
  const { filters } = input;
  const params = new URLSearchParams();
  if (filters.projectId !== '') params.set('project', filters.projectId);
  if (filters.states.length > 0) params.set('state', [...filters.states].join(','));
  if (filters.stageIds.length > 0) params.set('stage', [...filters.stageIds].join(','));
  if (filters.doer !== '') params.set('doer', filters.doer);
  if (filters.teamId !== '') params.set('team', filters.teamId);
  if (filters.due !== 'any') params.set('due', filters.due);
  if (input.view === 'board') params.set('view', 'board');
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** Whether an item's due day passes the Due filter, judged against the reader's `today`. */
export function matchesDue(item: WorkItemSummary, filter: DueFilter, today: string): boolean {
  if (filter === 'any') return true;
  const due = dayOf(item.dueAt);
  if (filter === 'none') return due === '';
  if (due === '') return false;
  if (filter === 'overdue')
    return due < today && item.state !== 'done' && item.state !== 'archived';
  if (filter === 'today') return due === today;
  if (filter === 'week') return due >= today && due <= addDays(today, 6);
  return due.slice(0, 7) === today.slice(0, 7);
}

/** The doers of an item: the list read's, else the lead (an older answer). */
export function doersOf(item: WorkItemSummary): readonly string[] {
  return item.doerUserIds ?? (item.ownerUserId === null ? [] : [item.ownerUserId]);
}

/** The filters the browser applies to the loaded rows (the API took the rest). */
export function applyLoadedFilters(
  rows: readonly WorkItemSummary[],
  filters: WorkListFilters,
  context: { readonly today: string; readonly viewerUserId: string | null },
): WorkItemSummary[] {
  const doer = filters.doer === ME ? context.viewerUserId : filters.doer;
  return rows.filter(
    (row) =>
      (filters.doer === '' || (doer !== null && doersOf(row).includes(doer))) &&
      (filters.stageIds.length === 0 ||
        (row.stageId != null && filters.stageIds.includes(row.stageId))) &&
      matchesDue(row, filters.due, context.today),
  );
}

/** How many filters are set beyond the project — the toolbar says so on a narrowed empty list. */
export function isFiltered(filters: WorkListFilters): boolean {
  return (
    filters.projectId !== '' ||
    filters.states.length > 0 ||
    filters.stageIds.length > 0 ||
    filters.doer !== '' ||
    filters.teamId !== '' ||
    filters.due !== 'any'
  );
}

/**
 * The rail's views (Figma `WV2-01`): each is a set of the toolbar's filters, named the way people
 * ask for them. Choosing one replaces the filters it names and keeps the project and the team.
 */
export type RailView = 'all' | 'mine' | 'week' | 'review';
export const RAIL_VIEWS: readonly RailView[] = ['all', 'mine', 'week', 'review'];

export function railViewFilters(view: RailView, current: WorkListFilters): WorkListFilters {
  const base: WorkListFilters = {
    ...NO_FILTERS,
    projectId: current.projectId,
    teamId: current.teamId,
  };
  switch (view) {
    case 'all':
      return base;
    case 'mine':
      return { ...base, doer: ME };
    case 'week':
      return { ...base, due: 'week' };
    case 'review':
      return { ...base, states: ['internal_review'] };
  }
}

/** The rail view the filters are, if any. */
export function activeRailView(filters: WorkListFilters): RailView | null {
  for (const view of RAIL_VIEWS) {
    const expected = railViewFilters(view, filters);
    if (
      expected.doer === filters.doer &&
      expected.due === filters.due &&
      expected.stageIds.length === filters.stageIds.length &&
      sameStates(expected.states, filters.states)
    ) {
      return view;
    }
  }
  return null;
}

export function sameStates(
  left: readonly WorkItemState[],
  right: readonly WorkItemState[],
): boolean {
  return left.length === right.length && left.every((state) => right.includes(state));
}

/** The rail's counts, from one read of every work (open and done; archived is off the list). */
export interface RailCounts {
  readonly views: Readonly<Record<RailView, number>>;
  readonly projects: ReadonlyMap<string, number>;
  readonly teams: ReadonlyMap<string, number>;
  /** The read was a full page: the counts are "at least". */
  readonly partial: boolean;
}

export function railCounts(
  rows: readonly WorkItemSummary[],
  context: {
    readonly today: string;
    readonly viewerUserId: string | null;
    readonly teamMembers: ReadonlyMap<string, readonly string[]>;
    readonly partial: boolean;
  },
): RailCounts {
  const live = rows.filter((row) => row.state !== 'archived');
  const count = (filters: WorkListFilters) =>
    applyLoadedFilters(
      live.filter((row) => filters.states.length === 0 || filters.states.includes(row.state)),
      filters,
      context,
    ).length;
  const projects = new Map<string, number>();
  for (const row of live) projects.set(row.projectId, (projects.get(row.projectId) ?? 0) + 1);
  const teams = new Map<string, number>();
  for (const [teamId, members] of context.teamMembers) {
    teams.set(teamId, live.filter((row) => doersOf(row).some((id) => members.includes(id))).length);
  }
  return {
    views: {
      all: live.length,
      mine: count(railViewFilters('mine', NO_FILTERS)),
      week: count(railViewFilters('week', NO_FILTERS)),
      review: count(railViewFilters('review', NO_FILTERS)),
    },
    projects,
    teams,
    partial: context.partial,
  };
}

/** The "Updated" cell's unit: minutes, hours, a day ("Yesterday"), days, weeks, months. */
export function ageOf(
  updatedAt: string,
  now: Date,
): { readonly value: number; readonly unit: 'minute' | 'hour' | 'day' | 'week' | 'month' } | null {
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 60) return { value: Math.max(1, minutes), unit: 'minute' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hour' };
  const days = Math.floor(hours / 24);
  if (days < 7) return { value: days, unit: 'day' };
  if (days < 30) return { value: Math.floor(days / 7), unit: 'week' };
  return { value: Math.max(1, Math.floor(days / 30)), unit: 'month' };
}
