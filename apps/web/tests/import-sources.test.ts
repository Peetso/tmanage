import { describe, expect, it } from 'vitest';
import {
  IMPORT_SOURCES,
  autoMap,
  buildBatch,
  flattenMondayGrid,
  parseCsv,
} from '../src/lib/import-sources';

describe('import sources (R31 A11)', () => {
  it('reads quoted CSV and maps a Trello export onto the Notion kind', () => {
    const table = parseCsv(
      '\uFEFFCard Name,List Name,Due Date\r\n"Fix ""login""",Doing,2026-03-04T12:00:00.000Z\r\n\r\n',
    );
    expect(table.rows).toEqual([
      { 'Card Name': 'Fix "login"', 'List Name': 'Doing', 'Due Date': '2026-03-04T12:00:00.000Z' },
    ]);
    const mapping = autoMap(IMPORT_SOURCES.trello, table.headers);
    const batch = buildBatch(IMPORT_SOURCES.trello, table.rows, mapping);
    expect(batch.sourceKind).toBe('notion_database');
    expect(batch.mapping).toEqual({ name: 'Card Name', status: 'List Name', date: 'Due Date' });
    expect(batch.rows[0]?.['Due Date']).toBe('2026-03-04');
  });

  it('flattens a monday board export: groups, items and sub-items', () => {
    const table = flattenMondayGrid([
      ['Board'],
      ['التصميم'],
      ['Name', 'Person', 'Status'],
      ['Logo', 'Ana', 'Done'],
      ['', 'Subitems', 'Status'],
      ['', 'Sketch', 'Done'],
      ['', '', ''],
      ['Copy', '', 'Stuck'],
    ]);
    expect(table.rows).toEqual([
      { Group: 'التصميم', Name: 'Logo', Person: 'Ana', Status: 'Done' },
      { Group: 'التصميم', Name: 'Sketch', Status: 'Done', 'Parent item': 'Logo' },
      { Group: 'التصميم', Name: 'Copy', Person: '', Status: 'Stuck' },
    ]);
    expect(autoMap(IMPORT_SOURCES.monday, table.headers)).toMatchObject({
      group: 'Group',
      parent: 'Parent item',
    });
  });
});
