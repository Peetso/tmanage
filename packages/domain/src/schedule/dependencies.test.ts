import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '../calendar/working-calendar.js';
import { cascade, findCycle, topologicalOrder } from './dependencies.js';
import type { DependencyKind } from './dependencies.js';

// 53-T-08. Sun–Thu company; 2026-11-06/07 is the Fri–Sat weekend, 2026-11-09 a holiday.
const calendar = defaultWorkingCalendar('Asia/Riyadh', ['2026-11-09']);
const item = (id: string, startAt: string, dueAt: string) => ({
  id,
  startAt,
  dueAt,
  projectId: 'p',
});
const edge = (workItemId: string, kind: DependencyKind, lag: number) => ({
  workItemId,
  dependsOnWorkItemId: 'A',
  kind,
  lag,
});
const items = [
  item('A', '2026-11-02', '2026-11-05'),
  item('FS', '2026-11-03', '2026-11-04'),
  item('SS', '2026-11-01', '2026-11-01'),
  item('FF', '2026-11-01', '2026-11-02'),
  item('SF', '2026-10-28', '2026-10-29'),
];
const edges = [edge('FS', 'FS', 1), edge('SS', 'SS', 2), edge('FF', 'FF', 0), edge('SF', 'SF', 0)];

describe('53-04 typed dependencies', () => {
  it('applies the four kinds with lag over the weekend and a holiday, keeping durations', () => {
    const { moves } = cascade({ items, edges, moved: items[0]!, calendar });
    const byId = Object.fromEntries(moves.map((m) => [m.id, [m.startAt, m.dueAt]]));
    expect(byId).toEqual({
      FS: ['2026-11-08', '2026-11-10'],
      SS: ['2026-11-04', '2026-11-04'],
      FF: ['2026-11-04', '2026-11-05'],
      SF: ['2026-11-01', '2026-11-02'],
    });
  });

  it('never pulls a successor earlier on a backward move', () => {
    const moved = { id: 'A', startAt: '2026-10-25', dueAt: '2026-10-26' };
    const shifted = cascade({ items, edges, moved, calendar }).moves.map((m) => m.id);
    expect(shifted).toEqual([]);
  });

  it('names the loop a new edge would close, and orders predecessors first', () => {
    const chain = [
      { workItemId: 'B', dependsOnWorkItemId: 'A' },
      { workItemId: 'C', dependsOnWorkItemId: 'B' },
    ];
    expect(findCycle(chain, { workItemId: 'A', dependsOnWorkItemId: 'C' })).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(findCycle(chain, { workItemId: 'C', dependsOnWorkItemId: 'A' })).toBeNull();
    expect(topologicalOrder(chain)).toEqual(['A', 'B', 'C']);
  });
});
