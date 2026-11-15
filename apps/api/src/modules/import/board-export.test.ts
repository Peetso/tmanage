import { describe, expect, it } from 'vitest';
import { boardCommitPlan, validateBoardRow } from './board-export.js';

describe('ClickUp task CSV (54-26)', () => {
  it('maps lists, emails, epoch dates, comments and nested subtasks', () => {
    const rows = [
      {
        'Task ID': 'a1',
        'Task Name': 'Launch',
        'List Name': 'Sprint',
        Status: 'قيد التنفيذ',
        Assignees: '[Ana@X.com]',
        'Due Date': '1772582400000',
        Comments: '[{"text":"ok","by":"Omar","date":"2026-03-01"}]',
      },
      { 'Task ID': 'b2', 'Task Name': 'Copy', 'Parent ID': 'a1', Status: 'complete' },
      { 'Task ID': 'c3', 'Task Name': 'Proof', 'Parent ID': 'b2', Status: 'Waiting' },
    ];
    expect(rows.map((row) => validateBoardRow({}, row))).toEqual([[], [], []]);
    const plan = boardCommitPlan(
      {},
      rows.map((row, rowIndex) => ({ rowIndex, row })),
    );
    expect(plan.items).toMatchObject([
      {
        title: 'Launch',
        state: 'in_progress',
        person: 'ana@x.com',
        dueOn: '2026-03-04',
        labels: ['Sprint'],
        comments: ['**Omar · 2026-03-01**\n\nok'],
      },
    ]);
    expect(plan.subitems).toEqual([
      { rowIndex: 1, parentRowIndex: 0, title: 'Copy', done: true },
      { rowIndex: 2, parentRowIndex: 0, title: 'Proof', done: false },
    ]);
    expect(plan.notes).toEqual(['board_status_unmapped:Waiting']);
  });
});
