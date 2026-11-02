import { describe, expect, it } from 'vitest';
import {
  jiraCommitPlan,
  mapStatus,
  onePrefix,
  parseIssueKey,
  sprintOf,
  sprintWindow,
} from './jira-issues.js';
import { validateBatch } from './import-validation.js';

const MAPPING = {
  issueKey: 'Issue key',
  summary: 'Summary',
  issueType: 'Issue Type',
  status: 'Status',
  statusCategory: 'Status Category',
  sprint: 'Sprint',
  parent: 'Parent',
  created: 'Created',
  dueDate: 'Due date',
};

describe('jira-issues (R21-e)', () => {
  it('parses WEB-123 and refuses web-123 and WEB-', () => {
    expect(parseIssueKey('WEB-123')).toEqual({ prefix: 'WEB', number: 123 });
    expect(parseIssueKey('web-123')).toBeNull();
    expect(parseIssueKey('WEB-')).toBeNull();
  });

  it('reports two prefixes in one batch as mixed_prefixes', () => {
    const rows = [
      { 'Issue key': 'WEB-1', Summary: 'a' },
      { 'Issue key': 'APP-2', Summary: 'b' },
    ];
    expect(onePrefix(MAPPING, rows).error?.code).toBe('mixed_prefixes');
    const report = validateBatch('jira_issues', MAPPING, rows);
    expect(report.status).toBe('validated_with_errors');
    expect(report.batchErrors.map((e) => e.code)).toEqual(['mixed_prefixes']);
  });

  it('maps a status by category, and the status map overrides it', () => {
    expect(mapStatus('Code Review', 'In Progress').state).toBe('in_progress');
    expect(
      mapStatus('Code Review', 'In Progress', { 'Code Review': 'internal_review' }).state,
    ).toBe('internal_review');
  });

  it('reads the last value of repeated Sprint headers', () => {
    expect(sprintOf(MAPPING, { Sprint: 'S1', Sprint_1: 'S2', Sprint_2: 'S3' })).toBe('S3');
    expect(sprintOf(MAPPING, { Sprint: ['S1', 'S2'] })).toBe('S2');
  });

  it('derives a sprint window from created and due dates', () => {
    const rows = [
      {
        rowIndex: 0,
        row: { Sprint: 'S1', Created: '12/Mar/24 10:15 AM', 'Due date': '2024-03-20' },
      },
      { rowIndex: 1, row: { Sprint: 'S1', Created: '2024-03-10' } },
    ];
    expect(sprintWindow(MAPPING, rows, '2026-11-02')).toEqual([
      { name: 'S1', startsOn: '2024-03-10', endsOn: '2024-03-20', rowIndexes: [0, 1] },
    ]);
  });

  it('keeps a sub-task parent, turns an epic into no item, and notes derived sprint dates', () => {
    const rows = [
      { 'Issue key': 'WEB-1', Summary: 'Checkout', 'Issue Type': 'Epic' },
      {
        'Issue key': 'WEB-2',
        Summary: 'Cart',
        'Issue Type': 'Story',
        Parent: 'WEB-1',
        Sprint: 'S1',
      },
      { 'Issue key': 'WEB-3', Summary: 'Fix', 'Issue Type': 'Sub-task', Parent: 'WEB-2' },
    ].map((row, rowIndex) => ({ rowIndex, row }));
    const plan = jiraCommitPlan(MAPPING, rows, { today: '2026-11-02', rowCap: 1000 });
    expect(plan.prefix).toBe('WEB');
    expect(plan.epics.map((e) => e.key)).toEqual(['WEB-1']);
    expect(plan.items.map((i) => i.key)).toEqual(['WEB-2', 'WEB-3']);
    expect(plan.items[0]?.epicKey).toBe('WEB-1');
    expect(plan.items[1]?.parentKey).toBe('WEB-2');
    expect(plan.notes).toContain('sprint_dates_derived');
    expect(plan.notes).toContain('worklogs_not_imported');
  });
});
