/**
 * 52-29 (plan 52 §16.3) — the one CSV cell-escaping rule every export uses.
 *
 * Before this module the API, the worker and the web app each carried their own escaper; this is
 * the single owner now, pure and I/O-free so a controller, a job and a browser download share it.
 *
 * - **CSV-injection guard** (`26-THREAT-MODELS` §exports / OWASP "CSV injection") — a cell whose
 *   first character a spreadsheet may read as a formula (`= + - @`, the `\t`/`\r` that lead into
 *   one, and the full-width / small equals signs some spreadsheets fold to `=`) is prefixed with a
 *   single quote so the sheet shows it as text, never as `=cmd|…`. The guard runs *before* the
 *   quoting test, so a neutralised value that also needs quoting gets both.
 * - **RFC 4180 quoting** — a cell containing a comma, a double quote, a CR or an LF is wrapped in
 *   double quotes with each interior quote doubled; anything else is emitted verbatim.
 * - **Records** end with CRLF, the last one included (RFC 4180 §2.1/§2.2). An optional UTF-8 BOM
 *   lets Excel open Arabic text in the right encoding.
 *
 * Imports keep their own parser-side rule; this file only writes.
 */

/** A value a cell may hold; `null`/`undefined` become an empty cell. */
export type CsvValue = string | number | boolean | null | undefined;

/** Leading characters a spreadsheet may treat as the start of a formula. */
const FORMULA_TRIGGER = /^[=+\-@\t\r＝﹦]/;

/** RFC 4180 characters that force a cell to be quoted. */
const NEEDS_QUOTING = /[",\r\n]/;

/** RFC 4180 record separator. */
export const CSV_RECORD_SEPARATOR = '\r\n';

/** The UTF-8 byte-order mark, as the one code unit a JS string carries it as. */
export const CSV_BOM = '﻿';

/** Escape one cell: neutralise a formula prefix, then quote if RFC 4180 requires it. */
export function escapeCsvCell(value: CsvValue): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = FORMULA_TRIGGER.test(text) ? `'${text}` : text;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export interface ToCsvOptions {
  /** Prefix the document with a UTF-8 BOM (Excel + Arabic). Default off. */
  readonly bom?: boolean;
}

/**
 * Serialise a table: the optional header first, then every row, each cell escaped, every record
 * CRLF-terminated. Pass `header` as `null`/omit it when the rows already carry their own.
 */
export function toCsv(
  rows: readonly (readonly CsvValue[])[],
  header?: readonly CsvValue[] | null,
  options: ToCsvOptions = {},
): string {
  const records = header ? [header, ...rows] : rows;
  const body = records
    .map((row) => `${row.map(escapeCsvCell).join(',')}${CSV_RECORD_SEPARATOR}`)
    .join('');
  return options.bom ? `${CSV_BOM}${body}` : body;
}
