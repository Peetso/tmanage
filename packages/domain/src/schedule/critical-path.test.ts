import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '../calendar/working-calendar.js';
import { criticalPath } from './critical-path.js';
import { DependencyCycleDetected } from './dependencies.js';
import type { DependencyKind } from './dependencies.js';

/** 53-T-14 — hand-computed CPM. Sun–Thu company (Fri–Sat weekend), Mon 2026-10-26 a holiday. */
const calendar = defaultWorkingCalendar('Asia/Riyadh', ['2026-10-26']);
const item = (id: string, startAt: string | null, dueAt: string | null) => ({
  id,
  startAt,
  dueAt,
  projectId: 'p',
});
const edge = (
  workItemId: string,
  dependsOnWorkItemId: string,
  kind: DependencyKind,
  lag: number,
) => ({
  workItemId,
  dependsOnWorkItemId,
  kind,
  lag,
});

describe('criticalPath', () => {
  it('runs the forward and backward pass over FS / SS / FF / SF with lag, weekend and holiday', () => {
    const result = criticalPath({
      calendar,
      items: [
        item('A', '2026-10-18', '2026-10-20'),
        item('B', '2026-10-18', '2026-10-19'),
        item('C', '2026-10-18', '2026-10-22'),
        item('D', '2026-10-19', '2026-10-19'),
        item('E', '2026-10-25', '2026-10-28'),
        item('F', '2026-10-18', '2026-10-21'),
        item('U', null, null),
      ],
      edges: [
        edge('B', 'A', 'FS', 0),
        edge('C', 'A', 'SS', 2),
        edge('D', 'B', 'FF', 1),
        edge('E', 'C', 'FS', 1),
        edge('F', 'D', 'SF', 0),
        edge('U', 'A', 'FS', 0),
      ],
    });
    const row = (id: string) => result.rows.find((r) => r.id === id);
    expect(row('A')).toMatchObject({
      earlyStart: '2026-10-18',
      lateFinish: '2026-10-20',
      totalFloatDays: 0,
    });
    expect(row('B')).toMatchObject({
      earlyFinish: '2026-10-21',
      lateStart: '2026-10-28',
      totalFloatDays: 5,
    });
    expect(row('C')).toMatchObject({
      earlyStart: '2026-10-20',
      earlyFinish: '2026-10-27',
      totalFloatDays: 0,
    });
    expect(row('D')).toMatchObject({
      earlyStart: '2026-10-22',
      lateFinish: '2026-11-01',
      totalFloatDays: 5,
    });
    expect(row('E')).toMatchObject({
      earlyStart: '2026-10-28',
      earlyFinish: '2026-11-01',
      isCritical: true,
    });
    expect(row('F')).toMatchObject({
      earlyStart: '2026-10-19',
      earlyFinish: '2026-10-22',
      lateStart: '2026-10-27',
    });
    expect(result).toMatchObject({
      criticalEndDate: '2026-11-01',
      criticalIds: ['A', 'C', 'E'],
      unscheduled: ['U'],
    });
  });

  it('bounds an item by an external predecessor without listing it, and refuses a loop', () => {
    const result = criticalPath({
      calendar,
      items: [item('G', '2026-10-18', '2026-10-19')],
      edges: [edge('G', 'X', 'FS', 0)],
      external: [{ id: 'X', startAt: null, dueAt: '2026-10-25' }],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ id: 'G', earlyStart: '2026-10-25', earlyFinish: '2026-10-27' }),
    ]);
    const loop = [edge('A', 'B', 'FS', 0), edge('B', 'A', 'FS', 0)];
    const items = [item('A', '2026-10-18', null), item('B', '2026-10-18', null)];
    expect(() => criticalPath({ calendar, items, edges: loop })).toThrow(DependencyCycleDetected);
  });
});
