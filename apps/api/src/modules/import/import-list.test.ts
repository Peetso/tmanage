import { describe, expect, it } from 'vitest';
import { IMPORT_UNDO_WINDOW_MS, importJobSummary } from './import.service.js';

const committedAt = new Date('2026-11-01T10:00:00.000Z');
const job = {
  id: '0190a000-0000-7000-8000-000000000001',
  sourceKind: 'jira_issues',
  status: 'committed_with_errors',
  totalCount: 12,
  committedCount: 10,
  failedCount: 2,
  createdAt: committedAt,
  committedAt,
  undoneAt: null,
};

describe('importJobSummary (R31 A11, GET …/imports)', () => {
  it('offers undo only inside the window and never for a project import', () => {
    const inside = committedAt.getTime() + 1000;
    expect(importJobSummary(job, inside).undoAvailableUntil).toBe(
      new Date(committedAt.getTime() + IMPORT_UNDO_WINDOW_MS).toISOString(),
    );
    expect(importJobSummary(job, inside + IMPORT_UNDO_WINDOW_MS).undoAvailableUntil).toBeNull();
    expect(
      importJobSummary({ ...job, sourceKind: 'project' }, inside).undoAvailableUntil,
    ).toBeNull();
    expect(importJobSummary(job, inside)).toMatchObject({ committedCount: 10, failedCount: 2 });
  });
});
