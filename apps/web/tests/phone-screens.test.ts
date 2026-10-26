import { describe, expect, it } from 'vitest';
import { phoneWorkLists, projectCards } from '../src/components/phone/PhoneWorkOverview';
import type { WorkItemSummary } from '../src/lib/api/work-items';
import type { ProjectSummary } from '../src/lib/api/projects';

const now = new Date('2026-10-26T09:00:00Z');
const row = (id: string, extra: Partial<WorkItemSummary>): WorkItemSummary =>
  ({
    id,
    projectId: 'p1',
    type: 'task',
    title: id,
    state: 'in_progress',
    ownerUserId: 'me',
    audience: 'internal',
    dueAt: '2026-10-29T12:00:00Z',
    ...extra,
  }) as WorkItemSummary;

describe('phone work overview', () => {
  it('keeps open work due within seven days, mine filtered by owner', () => {
    const lists = phoneWorkLists(
      [
        row('a', {}),
        row('b', { ownerUserId: 'other' }),
        row('c', { state: 'done' }),
        row('d', { dueAt: '2026-11-20T12:00:00Z' }),
      ],
      'me',
      now,
    );
    expect(lists.week.map((r) => r.id)).toEqual(['a', 'b']);
    expect(lists.mine.map((r) => r.id)).toEqual(['a']);
  });

  it('rings a project by its done share of the loaded rows', () => {
    const project = { id: 'p1', name: 'Atlas' } as ProjectSummary;
    const [card] = projectCards([row('a', {}), row('b', { state: 'done' })], [project]);
    expect(card).toMatchObject({ percent: 50, open: 1 });
  });
});
