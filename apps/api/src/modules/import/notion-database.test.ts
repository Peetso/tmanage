import { describe, expect, it } from 'vitest';
import { notionCommitPlan, parseNotionDate, validateNotionRow } from './notion-database.js';

const ROW = {
  Name: 'تصميم الصفحة الرئيسية',
  Status: 'In progress',
  Assign: 'ليلى حسن',
  Due: 'March 4, 2026 → March 9, 2026',
  Tags: 'Design, Urgent',
};

describe('notion database CSV', () => {
  it('plans one item with a date range, two labels and the in-progress state', () => {
    expect(validateNotionRow({}, ROW)).toEqual([]);
    const plan = notionCommitPlan({}, [{ rowIndex: 0, row: ROW }], {
      resolvePerson: (name) => (name === 'ليلى حسن' ? 'user-9' : null),
    });
    expect(plan.items[0]).toMatchObject({
      title: 'تصميم الصفحة الرئيسية',
      state: 'in_progress',
      startOn: '2026-03-04',
      dueOn: '2026-03-09',
      labels: ['Design', 'Urgent'],
      ownerUserId: 'user-9',
    });
    expect(plan.notes).toEqual([]);
  });

  it('maps an unknown status to backlog with a note, and counts an unmatched person', () => {
    const plan = notionCommitPlan({}, [{ rowIndex: 0, row: { ...ROW, Status: 'Waiting' } }], {
      resolvePerson: () => null,
    });
    expect(plan.items[0]?.state).toBe('backlog');
    expect(plan.items[0]?.ownerUserId).toBeNull();
    expect(plan.notes).toEqual(['notion_status_unmapped:Waiting', 'notion_person_unmatched:1']);
  });

  it('reads ISO dates and refuses a missing title or a backwards range', () => {
    expect(parseNotionDate('2026-03-04')).toEqual({ start: null, end: '2026-03-04' });
    expect(validateNotionRow({}, { Name: ' ', Due: 'March 9, 2026 → March 4, 2026' })).toEqual([
      expect.objectContaining({ field: 'name' }),
      expect.objectContaining({ field: 'date' }),
    ]);
  });
});
