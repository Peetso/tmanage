import { describe, expect, it } from 'vitest';
import { isUuidV7 } from '@tmanage/domain';
import { SYNTHETIC_WORK_STATES, syntheticWorkItemRows } from './work-volume.js';

const INPUT = {
  organizationId: '01920000-0000-7000-8000-000000000001',
  projectId: '01920000-0000-7000-8000-000000000002',
  count: 120,
  anchor: new Date('2026-08-30T12:00:00.000Z'),
};

describe('syntheticWorkItemRows', () => {
  it('shapes load rather than copying one row: states, audiences and dates all vary', () => {
    const rows = syntheticWorkItemRows(INPUT);
    expect(rows).toHaveLength(120);

    const states = new Set(rows.map((row) => row.state));
    for (const state of new Set(SYNTHETIC_WORK_STATES)) expect(states).toContain(state);

    const withDue = rows.filter((row) => row.dueAt !== null);
    expect(withDue.length).toBeGreaterThan(0);
    expect(withDue.length).toBeLessThan(rows.length); // The null case exists too.
    const late = withDue.filter((row) => (row.dueAt as Date) < INPUT.anchor);
    const future = withDue.filter((row) => (row.dueAt as Date) > INPUT.anchor);
    expect(late.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(0);
  });

  it('gives every row a well-formed id and a title that names its ordinal', () => {
    const rows = syntheticWorkItemRows({ ...INPUT, count: 7, label: 'Perf' });
    const titles = new Set(rows.map((row) => row.title));
    expect(titles.size).toBe(7);
    expect(rows[0]?.title).toBe('Perf item 0001');
    for (const row of rows) {
      expect(isUuidV7(row.id)).toBe(true);
      expect(row.organizationId).toBe(INPUT.organizationId);
      expect(row.projectId).toBe(INPUT.projectId);
    }
  });
});
