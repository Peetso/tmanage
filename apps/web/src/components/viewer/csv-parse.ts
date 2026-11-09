/**
 * Peter, 2026-11-09 (viewer item 8) — CSV for the table view: quoted fields, doubled quotes, line
 * breaks inside quotes, and the separator guessed from the first line (`,`, `;` as European
 * spreadsheets write it, or a tab). Bounded by {@link MAX_CSV_ROWS}.
 */

export const MAX_CSV_ROWS = 2_000;

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvTable {
  readonly rows: readonly (readonly string[])[];
  readonly columns: number;
  /** `true` when the file has more rows than were read. */
  readonly truncated: boolean;
}

/** The separator the first line uses most, outside quotes. */
export function guessDelimiter(text: string): CsvDelimiter {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const outside = firstLine.replace(/"[^"]*"/gu, '');
  const counts: [CsvDelimiter, number][] = [
    [',', outside.split(',').length - 1],
    [';', outside.split(';').length - 1],
    ['\t', outside.split('\t').length - 1],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsv(text: string, delimiter: CsvDelimiter | null = null): CsvTable {
  const separator = delimiter ?? guessDelimiter(text);
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  let index = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    rows.push(row);
    row = [];
  };
  while (index < source.length) {
    const ch = source[index] as string;
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      index += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[index + 1] === '\n') index += 1;
      endRow();
      if (rows.length >= MAX_CSV_ROWS) {
        truncated = index + 1 < source.length;
        break;
      }
    } else {
      field += ch;
    }
    index += 1;
  }
  if (!truncated && (field !== '' || row.length > 0)) endRow();
  const columns = rows.reduce((max, current) => Math.max(max, current.length), 0);
  return { rows, columns, truncated };
}
