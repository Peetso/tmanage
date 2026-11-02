import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '@tmanage/domain';
import { weekBuckets } from '../people/workload-hours.js';
import {
  PEOPLE_PAGE_SIZE,
  buildOrgWorkload,
  cutPage,
  parsePage,
  parseScope,
  requireScope,
} from './org-workload-rules.js';

/** 53-08 part 2a (R21-a) — scope and cursor parsing, the page cut, the Unassigned row. */

const PROJECT = '0b9e4f9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

describe('org workload rules', () => {
  it('parses org (default) and project:<uuid>; anything else is invalid → 400', () => {
    expect(parseScope(undefined)).toEqual({ kind: 'org' });
    expect(parseScope('org')).toEqual({ kind: 'org' });
    expect(parseScope(`project:${PROJECT}`)).toEqual({ kind: 'project', projectId: PROJECT });
    expect(parseScope('team:x')).toBe('invalid');
    expect(parseScope('project:nope')).toBe('invalid');
    expect(() => requireScope('team:x')).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('cuts 51 rows to 50 with a cursor; a bad cursor is a 400', () => {
    const rows = Array.from({ length: PEOPLE_PAGE_SIZE + 1 }, (_, i) => ({
      membershipId: `m-${String(i).padStart(3, '0')}`,
    }));
    const { page, nextCursor } = cutPage(rows);
    expect(page).toHaveLength(50);
    expect(nextCursor).toBe('m-049');
    expect(cutPage(rows.slice(0, 50)).nextCursor).toBeNull();
    expect(parsePage(undefined)).toEqual({ afterMembershipId: null });
    expect(() => parsePage("x' or 1=1")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('spreads only readable owner-less items into the Unassigned row, rounded to 0.5 h', () => {
    const weeks = weekBuckets('2026-11-02', '2026-11-08');
    const view = buildOrgWorkload({
      weeks,
      people: [],
      unassigned: [
        {
          projectId: 'p',
          readable: true,
          startOn: null,
          dueOn: '2026-11-03',
          estimateMinutes: 185,
        },
        {
          projectId: 'q',
          readable: false,
          startOn: null,
          dueOn: '2026-11-03',
          estimateMinutes: 600,
        },
      ],
      calendar: defaultWorkingCalendar('UTC'),
      nextCursor: null,
    });
    expect(view.unassigned.weeks).toEqual([{ weekStart: '2026-11-02', hours: 3 }]);
    expect(JSON.stringify(view)).not.toContain('"q"');
  });
});
