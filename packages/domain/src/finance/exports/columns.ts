/**
 * 52-11 — the shared machinery behind the seven column maps: the per-run formatter, the column and
 * file builders each target file uses, a small RFC 4180 reader and the fixture validator
 * (UNIT-52-15: required columns present, dates in the vendor format, decimals, tax codes mapped).
 *
 * Writing goes through the one CSV writer (`toCsv`, 52-29) in `build-export.ts`; nothing here
 * escapes a cell.
 */

import type { CsvValue } from '../../export/csv.js';
import { CURRENCY_DIGITS } from '../../money/money.js';
import type {
  ColumnSpec,
  ColumnType,
  CreditNoteExportRow,
  CreditNoteLineExportRow,
  CustomerExportRow,
  DateFormat,
  ExpenseExportRow,
  ExportFile,
  ExportFormatter,
  ExportInput,
  ExportKind,
  FileSpec,
  InvoiceExportRow,
  InvoiceLineExportRow,
  PaymentExportRow,
  TargetMap,
  TaxCategory,
} from './types.js';

const TAX_CATEGORIES: readonly TaxCategory[] = ['S', 'Z', 'E', 'O'];

/** Arabic-script blocks (base, supplement, extended-A, presentation forms A/B). */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu;

function digitsOf(currency: string): number {
  return CURRENCY_DIGITS[currency] ?? 2;
}

function scaled(value: number, own: number, shown: number): string {
  const negative = value < 0;
  const abs = BigInt(Math.abs(Math.trunc(value)));
  const scale = 10n ** BigInt(own);
  const whole = abs / scale;
  const frac = own === 0 ? '' : (abs % scale).toString().padStart(own, '0');
  const sign = negative && abs !== 0n ? '-' : '';
  return `${sign}${whole}.${frac.padEnd(shown, '0')}`;
}

/**
 * Minor units to a decimal string: at least two places (the vendor templates' `decimals: 2`), three
 * for the three-digit currencies (KWD, BHD, OMR, …) so no fils are lost. Integer arithmetic only.
 */
export function minorToDecimal(minor: number, currency: string): string {
  const own = digitsOf(currency);
  return scaled(minor, own, Math.max(2, own));
}

/** Basis points to a percentage without trailing zeros: 1500 → `15`, 1250 → `12.5`. */
export function bpToPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/u, '')}`;
}

export function stripArabic(text: string): string {
  return text.replace(ARABIC_SCRIPT, '').replace(/\s+/gu, ' ').trim();
}

function formatDate(iso: string | null, format: DateFormat): string {
  if (iso === null || iso === '') return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (format === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
  if (format === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
  return `${y}-${m}-${d}`;
}

export function taxCategoryOf(bp: number, category?: string | null): TaxCategory {
  if (category !== null && category !== undefined) {
    const upper = category.toUpperCase();
    if ((TAX_CATEGORIES as readonly string[]).includes(upper)) return upper as TaxCategory;
  }
  return bp > 0 ? 'S' : 'O';
}

export function makeFormatter(map: TargetMap, latinOnly: boolean): ExportFormatter {
  return {
    latinOnly,
    date: (iso) => formatDate(iso, map.dateFormat),
    amount: (minor, currency) => minorToDecimal(minor, currency),
    quantity: (centi) => scaled(centi, 2, 2),
    percent: (bp) => bpToPercent(bp),
    tax: (bp, category) =>
      map.taxCodeMap[taxCategoryOf(bp, category)].replace('{rate}', bpToPercent(bp)),
    text: (en, ar) => {
      const english = en?.trim() ?? '';
      const arabic = ar?.trim() ?? '';
      if (latinOnly) return stripArabic(english) || stripArabic(arabic);
      if (english !== '' && arabic !== '' && english !== arabic) return `${english} / ${arabic}`;
      return english || arabic;
    },
    arabic: (ar) => (latinOnly ? '' : (ar ?? '')),
  };
}

// ── column + file builders ───────────────────────────────────────────────────

type Getter<R> = (row: R, f: ExportFormatter) => CsvValue;

/** A required line-level column. */
export const req = <R>(name: string, type: ColumnType, value: Getter<R>): ColumnSpec<R> => ({
  name,
  type,
  required: true,
  scope: 'line',
  value,
});
/** An optional line-level column. */
export const opt = <R>(name: string, type: ColumnType, value: Getter<R>): ColumnSpec<R> => ({
  name,
  type,
  required: false,
  scope: 'line',
  value,
});
/** A document-level column (blank on continuation rows in a `continuation` file). */
export const doc = <R>(column: ColumnSpec<R>): ColumnSpec<R> => ({ ...column, scope: 'doc' });

export interface InvoiceLineRow {
  readonly invoice: InvoiceExportRow;
  readonly line: InvoiceLineExportRow;
}
export interface CreditNoteLineRow {
  readonly note: CreditNoteExportRow;
  readonly line: CreditNoteLineExportRow;
}

interface Sourced<R> {
  readonly row: R;
  readonly first: boolean;
}

function fileOf<R>(
  kind: ExportKind,
  name: string,
  source: (input: ExportInput) => readonly Sourced<R>[],
  columns: readonly ColumnSpec<R>[],
  continuation: boolean,
): FileSpec {
  return {
    kind,
    name,
    continuation,
    header: columns.map((column) => column.name),
    columns: columns.map(({ name: n, type, required, scope }) => ({
      name: n,
      type,
      required,
      scope,
    })),
    rows: (input, f) =>
      source(input).map(({ row, first }) =>
        columns.map((column) =>
          continuation && !first && column.scope === 'doc' ? '' : column.value(row, f),
        ),
      ),
  };
}

const flat = <R>(rows: readonly R[]): readonly Sourced<R>[] =>
  rows.map((row) => ({ row, first: true }));

export function invoiceLinesFile(
  name: string,
  columns: readonly ColumnSpec<InvoiceLineRow>[],
  continuation = false,
): FileSpec {
  return fileOf(
    'invoices',
    name,
    (input) =>
      input.invoices.flatMap((invoice) =>
        invoice.lines.map((line, index) => ({ row: { invoice, line }, first: index === 0 })),
      ),
    columns,
    continuation,
  );
}

export function creditNoteLinesFile(
  name: string,
  columns: readonly ColumnSpec<CreditNoteLineRow>[],
  continuation = false,
): FileSpec {
  return fileOf(
    'credit_notes',
    name,
    (input) =>
      input.creditNotes.flatMap((note) =>
        note.lines.map((line, index) => ({ row: { note, line }, first: index === 0 })),
      ),
    columns,
    continuation,
  );
}

export function paymentsFile(
  name: string,
  columns: readonly ColumnSpec<PaymentExportRow>[],
): FileSpec {
  return fileOf('payments', name, (input) => flat(input.payments), columns, false);
}

export function customersFile(
  name: string,
  columns: readonly ColumnSpec<CustomerExportRow>[],
): FileSpec {
  return fileOf('customers', name, (input) => flat(input.customers), columns, false);
}

export function expensesFile(
  name: string,
  columns: readonly ColumnSpec<ExpenseExportRow>[],
): FileSpec {
  return fileOf('expenses', name, (input) => flat(input.expenses), columns, false);
}

/**
 * The customer's name as the books match it. Never blank: a name that is Arabic only stays as it
 * is even in a Latin-only run, because an empty contact would fail every import.
 */
export function customerName(f: ExportFormatter, name: string): string {
  return f.text(name, null) || name;
}

/** A description that is never empty (a required column): falls back to the unit. */
export function describe(
  f: ExportFormatter,
  en: string | null,
  ar: string | null,
  unit: string,
): string {
  return f.text(en, ar) || unit;
}

export function addressOf(c: CustomerExportRow, f: ExportFormatter): string {
  return f.text(c.billingAddressEn, c.billingAddressAr);
}

// ── reading back (the fixture validator) ─────────────────────────────────────

/** A small RFC 4180 reader: BOM stripped, quoted cells, doubled quotes, CRLF records. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && source[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const DATE_PATTERNS: Readonly<Record<DateFormat, RegExp>> = {
  'YYYY-MM-DD': /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u,
  'DD/MM/YYYY': /^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/u,
  'MM/DD/YYYY': /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/u,
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function taxPattern(map: TargetMap): RegExp {
  const options = Object.values(map.taxCodeMap).map((template) =>
    escapeRegExp(template).replace('\\{rate\\}', '\\d+(\\.\\d{1,2})?'),
  );
  return new RegExp(`^(?:${options.join('|')})$`, 'u');
}

function cellProblem(type: ColumnType, value: string, map: TargetMap, tax: RegExp): string | null {
  switch (type) {
    case 'date':
      return DATE_PATTERNS[map.dateFormat].test(value) ? null : `not a ${map.dateFormat} date`;
    case 'amount':
      return /^\d+\.\d{2,3}$/u.test(value) ? null : 'not a 2-decimal amount';
    case 'quantity':
      return /^\d+\.\d{2}$/u.test(value) ? null : 'not a 2-decimal quantity';
    case 'percent':
      return /^\d+(\.\d{1,2})?$/u.test(value) ? null : 'not a percentage';
    case 'tax':
      return tax.test(value) ? null : 'tax code not mapped';
    default:
      return null;
  }
}

/**
 * The fixture validator a target's `validate` runs: every file is one of the target's, its header
 * is the template header verbatim, required cells are filled, dates are in the vendor's format,
 * amounts carry 2 (or 3) decimals and every tax cell is a mapped tax code. Returns the problems;
 * an empty list is a pass.
 */
export function validateFiles(map: TargetMap, files: readonly ExportFile[]): string[] {
  const problems: string[] = [];
  const tax = taxPattern(map);
  for (const file of files) {
    const spec = map.files.find((candidate) => candidate.name === file.name);
    if (spec === undefined) {
      problems.push(`${file.name}: not a ${map.target} file`);
      continue;
    }
    const [header, ...rows] = parseCsv(file.text);
    if (header === undefined || header.join(',') !== spec.header.join(',')) {
      problems.push(`${file.name}: header differs from the template`);
      continue;
    }
    rows.forEach((row, index) => {
      if (row.length !== spec.columns.length) {
        problems.push(`${file.name} row ${index + 2}: ${row.length} cells`);
        return;
      }
      const continuationRow = spec.continuation && row[0] === '';
      spec.columns.forEach((column, at) => {
        const value = row[at] ?? '';
        if (continuationRow && column.scope === 'doc') return;
        if (value === '') {
          if (column.required) problems.push(`${file.name} row ${index + 2}: ${column.name} empty`);
          return;
        }
        const problem = cellProblem(column.type, value, map, tax);
        if (problem !== null) {
          problems.push(`${file.name} row ${index + 2}: ${column.name} ${problem}`);
        }
      });
    });
  }
  return problems;
}
