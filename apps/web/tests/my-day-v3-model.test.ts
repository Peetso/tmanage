import { describe, expect, it } from 'vitest';
import type { MyDayEntry, WaitingEntry } from '../src/components/my-day/my-day-model';
import {
  deriveCounts,
  dueGroup,
  dueRows,
  nextKey,
  pickNext,
  projectRows,
  splitWaiting,
} from '../src/components/my-day/my-day-model';
import {
  ALWAYS_SHOWN,
  DEFAULT_LAYOUT,
  foldLayout,
  moveWidget,
  movable,
  setHidden,
  toPrefs,
} from '../src/components/my-day/my-day-layout';
import { HOME_WIDGET_IDS } from '../src/lib/api/home-widget-prefs';

/**
 * My Day v3.1 widget logic (spec §7, checks C3 and C4): every count on the page comes from the one
 * ranked read, so a number never disagrees with the list under it, and Next is never listed twice.
 */

const NOW = Date.parse('2026-11-22T09:42:00');
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString();

function work(id: string, projectId: string, reason: MyDayEntry['reason'], due: number | null) {
  return {
    reason,
    workItem: {
      id,
      projectId,
      type: 'task',
      title: `Task ${id}`,
      state: 'in_progress',
      ownerUserId: 'u1',
      audience: 'internal',
      startAt: null,
      dueAt: due === null ? null : day(due),
      completedAt: null,
      version: 1,
      createdAt: day(-10),
      updatedAt: day(-1),
      deletedAt: null,
    },
  } as MyDayEntry;
}

function request(
  id: string,
  projectId: string,
  reason: 'client_triage' | 'stale_follow_up',
  since: number,
) {
  return {
    kind: 'client_request',
    reason,
    clientRequestId: id,
    projectId,
    title: `Request ${id}`,
    waitingSince: day(since),
  } as WaitingEntry;
}

function approval(id: string, projectId: string, since: number) {
  return {
    kind: 'approval',
    reason: 'approval_requested',
    approvalId: id,
    deliverableId: `d-${id}`,
    projectId,
    requestedAt: day(since),
    deliverableTitle: 'Logo',
    versionNo: 2,
    version: 1,
  } as WaitingEntry;
}

const ITEMS = [
  work('w1', 'p1', 'overdue', -2),
  work('w2', 'p1', 'overdue', -1),
  work('w3', 'p2', 'due_soon', 0),
  work('w4', 'p2', 'due_soon', 2),
  work('w5', 'p3', 'assigned', 9),
  work('w6', 'p3', 'assigned', null),
];
const WAITING = splitWaiting([
  request('r1', 'p2', 'client_triage', -1),
  approval('a1', 'p1', -3),
  request('r2', 'p3', 'stale_follow_up', -4),
]);

describe('My Day v3.1 model', () => {
  it('splits Waiting into On you and On others, oldest first', () => {
    expect(WAITING.onYou.map((entry) => entry.projectId)).toEqual(['p1', 'p2']);
    expect(WAITING.onOthers).toHaveLength(1);
  });

  it('picks late work for Next before anything waiting, then the oldest waiting item', () => {
    expect(nextKey(pickNext(ITEMS, WAITING.onYou))).toBe('work:w1');
    const calm = ITEMS.filter((entry) => entry.reason !== 'overdue');
    expect(nextKey(pickNext(calm, WAITING.onYou))).toBe('waiting:a1');
    expect(pickNext([], [])).toBeNull();
  });

  it('groups due work: overdue, due today, due soon, later', () => {
    expect(ITEMS.map((entry) => dueGroup(entry, NOW))).toEqual([
      'overdue',
      'overdue',
      'today',
      'soon',
      'later',
      'later',
    ]);
  });

  it('the chip counts agree with the rows each chip shows', () => {
    const counts = deriveCounts({
      summary: undefined,
      items: ITEMS,
      waiting: WAITING,
      waitingLoaded: true,
      meetings: 3,
      now: NOW,
    });
    expect(counts.overdue).toBe(dueRows(ITEMS, 'overdue', null, NOW, 99).length);
    expect(counts.today).toBe(dueRows(ITEMS, 'today', null, NOW, 99).length);
    expect(counts.soon).toBe(dueRows(ITEMS, 'soon', null, NOW, 99).length);
    expect(counts.open).toBe(ITEMS.length);
    expect(counts.waitingOnYou).toBe(WAITING.onYou.length);
    expect(counts.waitingOnOthers).toBe(WAITING.onOthers.length);
    expect(counts.meetings).toBe(3);
  });

  it('takes the open total and the overdue count from the summary when the list is capped', () => {
    const counts = deriveCounts({
      summary: {
        personalWork: { total: 40, overdue: 7, dueSoon: 5 },
        waiting: { total: 6, approvals: 2, clientRequests: 4, staleFollowUps: 1 },
      },
      items: ITEMS,
      waiting: { onYou: [], onOthers: [] },
      waitingLoaded: false,
      meetings: 0,
      now: NOW,
    });
    expect(counts).toMatchObject({ open: 40, overdue: 7, waitingOnYou: 5, waitingOnOthers: 1 });
  });

  it('Due & at risk leaves out the item Next shows, and keeps the most urgent first', () => {
    const rows = dueRows(ITEMS, null, 'w1', NOW, 5).map((entry) => entry.workItem.id);
    expect(rows).not.toContain('w1');
    expect(rows).toEqual(['w2', 'w3', 'w4', 'w5', 'w6']);
    expect(dueRows(ITEMS, null, null, NOW, 5)).toHaveLength(5);
  });

  it('an empty read gives empty lists and zero counts (the widgets collapse to one line)', () => {
    const empty = splitWaiting([]);
    const counts = deriveCounts({
      summary: undefined,
      items: [],
      waiting: empty,
      waitingLoaded: true,
      meetings: 0,
      now: NOW,
    });
    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
    expect(dueRows([], 'today', null, NOW)).toEqual([]);
    expect(projectRows([], empty, NOW)).toEqual([]);
  });

  it('By project counts each project from the same read', () => {
    const rows = projectRows(ITEMS, WAITING, NOW);
    expect(rows.map((row) => row.projectId)).toEqual(['p1', 'p2', 'p3']);
    expect(rows.reduce((sum, row) => sum + row.open, 0)).toBe(ITEMS.length);
    const p1 = rows[0];
    expect(p1).toMatchObject({ open: 2, late: 2, waitingOnYou: 1, nextDue: null });
    expect(rows[1]?.nextDue).toBe(ITEMS[2]?.workItem.dueAt);
    expect(rows[2]?.waitingOnOthers).toBe(1);
  });
});

describe('My Day v3.1 layout', () => {
  it('places every allowlisted widget in exactly one group', () => {
    const placed = Object.values(DEFAULT_LAYOUT).flat();
    expect([...placed].sort()).toEqual([...HOME_WIDGET_IDS].sort());
  });

  it('keeps a saved order, appends widgets the saved order lacks, and ignores unknown ids', () => {
    const layout = foldLayout({
      order: ['timer', 'summary', 'ghost' as never],
      hidden: ['recent'],
    });
    expect(layout.groups.side.slice(0, 2)).toEqual(['timer', 'summary']);
    expect(layout.groups.side).toHaveLength(DEFAULT_LAYOUT.side.length);
    expect(layout.hidden.has('recent')).toBe(true);
  });

  it('never hides Next, even when a saved row says so', () => {
    expect(foldLayout({ order: [], hidden: ['next'] }).hidden.has('next')).toBe(false);
    const layout = foldLayout(undefined);
    expect(setHidden(layout, 'next', true)).toBe(layout);
    expect(ALWAYS_SHOWN.has('next')).toBe(true);
  });

  it('moves a widget inside its own group only, and not past either end', () => {
    const layout = foldLayout(undefined);
    const moved = moveWidget(layout, 'byProject', -1);
    expect(moved.groups.main).toEqual(['next', 'byProject', 'myDay', 'businessBriefing']);
    expect(moveWidget(layout, 'next', -1)).toBe(layout);
    expect(moveWidget(layout, 'pulse', 1)).toBe(layout);
    expect(movable('top')).toBe(false);
  });

  it('round-trips through the stored shape', () => {
    const layout = setHidden(moveWidget(foldLayout(undefined), 'recent', -1), 'pins', true);
    expect(foldLayout(toPrefs(layout))).toEqual(layout);
  });
});
