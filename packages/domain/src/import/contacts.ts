/**
 * 54-11 Phase 0 — contacts files into invite suggestions (R16-f).
 *
 * Two pure parsers, no I/O: {@link parseContactsCsv} for a Google or Outlook CSV export (or any CSV
 * with a column called email / e-mail), and {@link parseVcard} for a vCard 3.0 / 4.0 file. Both
 * return the same shape — the usable contacts, how many records were skipped, and why — so the API
 * can answer an import with counts and never echo the addresses back.
 *
 * What the parsers promise:
 *
 * - **Emails** are trimmed, lower-cased and checked by an RFC-lite rule (one `@`, a dotted domain,
 *   no spaces or brackets, at most 320 characters). A record without a valid email is skipped.
 * - **Duplicates collapse** on the lower-cased email; the first record wins.
 * - **At most {@link CONTACT_IMPORT_MAX_ROWS} records** are read; every record past the cap is
 *   counted as skipped (`over_limit`), never silently dropped.
 * - **Text is kept verbatim** (Arabic names included), trimmed and clamped to 300 characters. Cells
 *   are data, never formulas: nothing here evaluates them, and any later CSV export of the stored
 *   rows goes through `toCsv` (`export/csv.ts`), which neutralises a leading `=`, `+`, `-`, `@`.
 * - A leading byte-order mark and CRLF line ends are accepted. The text arrives already decoded —
 *   a Windows-1256 file must be decoded by the caller; these functions never guess an encoding.
 * - vCard `CHARSET` / `ENCODING` parameters are ignored, except that a `QUOTED-PRINTABLE` value is
 *   not decoded: it is skipped and counted (`quoted_printable`).
 */

import type { CsvValue } from '../export/csv.js';

/** The most records one import reads; the rest are counted as skipped. */
export const CONTACT_IMPORT_MAX_ROWS = 5_000;
/** The largest import text, measured in UTF-8 bytes. */
export const CONTACT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Matches the `email` column, `VARCHAR(320)`. */
export const CONTACT_EMAIL_MAX_LENGTH = 320;
/** Matches the `display_name` / `company` columns, `VARCHAR(300)`. */
export const CONTACT_TEXT_MAX_LENGTH = 300;

export interface ParsedContact {
  readonly displayName: string | null;
  /** Lower-cased and validated. */
  readonly email: string;
  readonly company: string | null;
}

export interface ContactSkipReasons {
  /** A record with no email at all. */
  readonly missing_email: number;
  /** A record whose email failed the RFC-lite check. */
  readonly invalid_email: number;
  /** A record whose email an earlier record already had. */
  readonly duplicate: number;
  /** A record past {@link CONTACT_IMPORT_MAX_ROWS}. */
  readonly over_limit: number;
  /** vCard values left undecoded because they were QUOTED-PRINTABLE (values, not records). */
  readonly quoted_printable: number;
}

export interface ContactParseResult {
  readonly contacts: readonly ParsedContact[];
  /** Records not imported (missing / invalid email, duplicate, over the cap). */
  readonly skipped: number;
  readonly reasons: ContactSkipReasons;
}

/** r46 — what happened to one record of the file (the preview and the error report). */
export type ContactRecordOutcome = 'ok' | 'missing_email' | 'invalid_email' | 'duplicate';

export interface ContactRecord {
  /** 1-based: the CSV row (the header is row 1) or the vCard card number. */
  readonly line: number;
  readonly displayName: string | null;
  /** Normalised when valid; the raw cell (cleaned) when invalid; null when missing. */
  readonly email: string | null;
  readonly company: string | null;
  readonly outcome: ContactRecordOutcome;
}

/** r46 — which CSV column (0-based) holds what. `null` = not in the file. */
export interface ContactColumnMapping {
  readonly email: number;
  readonly name: number | null;
  readonly company: number | null;
}

const EMAIL_PATTERN = /^[^\s@"<>(),;:\\[\]]+@[^\s@"<>(),;:\\[\]]+\.[^\s@"<>(),;:\\[\]]{2,}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Lower-case and validate one email, or null when it is not one. */
export function normaliseContactEmail(raw: string): string | null {
  let value = raw.trim();
  if (value.toLowerCase().startsWith('mailto:')) value = value.slice('mailto:'.length).trim();
  value = value.toLowerCase();
  if (value.length === 0 || value.length > CONTACT_EMAIL_MAX_LENGTH) return null;
  return EMAIL_PATTERN.test(value) ? value : null;
}

function cleanText(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  if (value === '') return null;
  return value.length > CONTACT_TEXT_MAX_LENGTH ? value.slice(0, CONTACT_TEXT_MAX_LENGTH) : value;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Collects records, applying the email rule, the duplicate rule and the cap in one place. */
class Collector {
  constructor(private readonly trace: ContactRecord[] | null = null) {}
  readonly contacts: ParsedContact[] = [];
  private readonly seen = new Set<string>();
  private records = 0;
  private skipped = 0;
  readonly reasons = {
    missing_email: 0,
    invalid_email: 0,
    duplicate: 0,
    over_limit: 0,
    quoted_printable: 0,
  };

  add(
    email: string | null,
    displayName: string | null,
    company: string | null,
    line: number = this.records + 1,
  ): void {
    this.records += 1;
    const note = (outcome: ContactRecordOutcome, address: string | null): void => {
      this.trace?.push({
        line,
        displayName: cleanText(displayName),
        email: address === null ? null : cleanText(address),
        company: cleanText(company),
        outcome,
      });
    };
    if (this.records > CONTACT_IMPORT_MAX_ROWS) return this.skip('over_limit', note, email);
    if (email === null || email.trim() === '') return this.skip('missing_email', note, null);
    const normalised = normaliseContactEmail(email);
    if (normalised === null) return this.skip('invalid_email', note, email);
    if (this.seen.has(normalised)) return this.skip('duplicate', note, normalised);
    this.seen.add(normalised);
    note('ok', normalised);
    this.contacts.push({
      displayName: cleanText(displayName),
      email: normalised,
      company: cleanText(company),
    });
  }

  private skip(
    reason: 'missing_email' | 'invalid_email' | 'duplicate' | 'over_limit',
    note: (outcome: ContactRecordOutcome, address: string | null) => void,
    address: string | null,
  ): void {
    this.skipped += 1;
    this.reasons[reason] += 1;
    // Past the cap only the count is kept: a 2 MB file must not grow an unbounded trace.
    if (reason !== 'over_limit') note(reason, address);
  }

  result(): ContactParseResult {
    return { contacts: this.contacts, skipped: this.skipped, reasons: { ...this.reasons } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

/** RFC 4180 rows: quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF. */
export function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
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

const EMAIL_HEADERS = ['e-mail 1 - value', 'e-mail address', 'email address', 'email', 'e-mail'];
const NAME_HEADERS = ['name', 'display name', 'full name'];
const COMPANY_HEADERS = [
  'organization 1 - name',
  'organization name',
  'company',
  'organization',
  'organisation',
];

interface CsvColumns {
  readonly email: number;
  readonly name: number;
  readonly first: number;
  readonly middle: number;
  readonly last: number;
  readonly company: number;
}

function findColumns(header: readonly string[]): CsvColumns {
  const keys = header.map((cell) => cell.trim().toLowerCase());
  const exact = (names: readonly string[]): number => {
    for (const name of names) {
      const at = keys.indexOf(name);
      if (at !== -1) return at;
    }
    return -1;
  };
  let email = exact(EMAIL_HEADERS);
  if (email === -1) {
    // Generic fallback: the first column that names an email and is not its type or label.
    email = keys.findIndex(
      (key) => (key.includes('email') || key.includes('e-mail')) && !/type|display|label/.test(key),
    );
  }
  let company = exact(COMPANY_HEADERS);
  if (company === -1) company = keys.findIndex((key) => key.includes('company'));
  return {
    email,
    name: exact(NAME_HEADERS),
    first: exact(['first name', 'given name']),
    middle: exact(['middle name', 'additional name']),
    last: exact(['last name', 'family name']),
    company,
  };
}

/** Google's multi-value cells read `a@x.com ::: b@y.com`; the first is the one used. */
function firstValue(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const first = cell.split(':::')[0] ?? '';
  return first.trim() === '' ? null : first;
}

/**
 * Parse a Google or Outlook contacts CSV (or any CSV with an email column). The first non-empty
 * row is the header. A file with no recognisable email column yields no contacts and counts every
 * data row as `missing_email`.
 */
export function parseContactsCsv(
  text: string,
  mapping?: ContactColumnMapping,
  trace: ContactRecord[] | null = null,
): ContactParseResult {
  const collector = new Collector(trace);
  const rows = splitCsvRows(stripBom(text))
    .map((cells, index) => ({ cells, line: index + 1 }))
    .filter((row) => row.cells.some((c) => c.trim() !== ''));
  const header = rows[0]?.cells;
  if (header === undefined) return collector.result();
  const guessed = findColumns(header);
  const columns: CsvColumns = mapping
    ? {
        ...guessed,
        email: mapping.email,
        name: mapping.name ?? -1,
        company: mapping.company ?? -1,
        ...(mapping.name !== null ? { first: -1, middle: -1, last: -1 } : {}),
      }
    : guessed;
  const at = (row: readonly string[], index: number): string | undefined =>
    index === -1 ? undefined : row[index];

  for (const { cells: row, line } of rows.slice(1)) {
    let name = cleanText(at(row, columns.name));
    if (name === null) {
      const parts = [columns.first, columns.middle, columns.last]
        .map((index) => cleanText(at(row, index)))
        .filter((part): part is string => part !== null);
      name = parts.length > 0 ? parts.join(' ') : null;
    }
    collector.add(
      firstValue(at(row, columns.email)),
      name,
      firstValue(at(row, columns.company)),
      line,
    );
  }
  return collector.result();
}

/** r46 — a CSV's header cells and the mapping the importer would guess for them. */
export function contactsCsvHeader(text: string): {
  readonly header: readonly string[];
  readonly mapping: ContactColumnMapping | null;
} {
  const first = splitCsvRows(stripBom(text)).find((row) => row.some((c) => c.trim() !== ''));
  if (first === undefined) return { header: [], mapping: null };
  const header = first.map((cell) => cleanText(cell) ?? '');
  const guessed = findColumns(first);
  return {
    header,
    mapping:
      guessed.email === -1
        ? null
        : {
            email: guessed.email,
            name: guessed.name === -1 ? null : guessed.name,
            company: guessed.company === -1 ? null : guessed.company,
          },
  };
}

/** r46 — whether `mapping` names columns that exist in a `width`-column header. */
export function isValidContactMapping(
  mapping: unknown,
  width: number,
): mapping is ContactColumnMapping {
  if (mapping === null || typeof mapping !== 'object') return false;
  const m = mapping as Record<string, unknown>;
  const col = (v: unknown, nullable: boolean): boolean =>
    (nullable && v === null) ||
    (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < width);
  return col(m['email'], false) && col(m['name'] ?? null, true) && col(m['company'] ?? null, true);
}

/** Why a record was not imported, in plain words (the error report's last column). */
const ERROR_REPORT_REASONS: Record<Exclude<ContactRecordOutcome, 'ok'>, string> = {
  missing_email: 'No e-mail address',
  invalid_email: 'Not a valid e-mail address',
  duplicate: 'Repeated in the file (an earlier row has this e-mail)',
};

/** r46 — the downloadable error report's header row. */
export const CONTACT_ERROR_REPORT_HEADER: readonly CsvValue[] = [
  'Row',
  'Name',
  'E-mail',
  'Company',
  'Problem',
];

/**
 * r46 — the downloadable error report's rows: one per record that was not imported. The caller
 * serialises them with `toCsv` (`export/csv.ts`, with a BOM), so a name like `=HYPERLINK(...)` is
 * neutralised before a spreadsheet opens it.
 */
export function contactErrorReportRows(records: readonly ContactRecord[]): CsvValue[][] {
  return records.flatMap((record) =>
    record.outcome === 'ok'
      ? []
      : [
          [
            record.line,
            record.displayName,
            record.email,
            record.company,
            ERROR_REPORT_REASONS[record.outcome],
          ],
        ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// vCard
// ─────────────────────────────────────────────────────────────────────────────

interface VcardLine {
  readonly name: string;
  readonly params: readonly string[];
  readonly value: string;
}

function parseVcardLine(line: string): VcardLine | null {
  // The value starts at the first ':' outside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [rawName = '', ...params] = line.slice(0, colon).split(';');
  const dot = rawName.lastIndexOf('.');
  return {
    name: (dot === -1 ? rawName : rawName.slice(dot + 1)).trim().toUpperCase(),
    params: params.map((param) => param.trim().toUpperCase()),
    value: line.slice(colon + 1),
  };
}

function isQuotedPrintable(params: readonly string[]): boolean {
  return params.some(
    (param) => param === 'ENCODING=QUOTED-PRINTABLE' || param === 'QUOTED-PRINTABLE',
  );
}

/** vCard text escapes: `\,` `\;` `\\` `\n`. */
function unescapeVcard(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_m, ch: string) => (ch === 'n' || ch === 'N' ? ' ' : ch));
}

/** Split a structured value on unescaped `;`. */
function components(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeVcard);
}

/**
 * Parse a vCard 3.0 / 4.0 file: one contact per `BEGIN:VCARD … END:VCARD`, from FN (or N when FN
 * is absent), the first EMAIL and the first ORG component. Folded lines are unfolded first.
 */
export function parseVcard(text: string, trace: ContactRecord[] | null = null): ContactParseResult {
  const collector = new Collector(trace);
  const unfolded = stripBom(text)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '');

  let inCard = false;
  let fn: string | null = null;
  let n: string | null = null;
  let email: string | null = null;
  let org: string | null = null;

  for (const raw of unfolded.split('\n')) {
    const line = parseVcardLine(raw);
    if (line === null) continue;
    const value = line.value.trim();
    if (line.name === 'BEGIN' && value.toUpperCase() === 'VCARD') {
      inCard = true;
      fn = n = email = org = null;
      continue;
    }
    if (!inCard) continue;
    if (line.name === 'END' && value.toUpperCase() === 'VCARD') {
      collector.add(email, fn ?? n, org);
      inCard = false;
      continue;
    }
    if (!['FN', 'N', 'EMAIL', 'ORG'].includes(line.name)) continue;
    if (isQuotedPrintable(line.params)) {
      collector.reasons.quoted_printable += 1;
      continue;
    }
    if (line.name === 'FN' && fn === null) {
      fn = cleanText(unescapeVcard(value));
    } else if (line.name === 'N' && n === null) {
      const [family = '', given = '', middle = ''] = components(value);
      n = cleanText([given, middle, family].filter((part) => part.trim() !== '').join(' '));
    } else if (line.name === 'EMAIL' && email === null && value !== '') {
      email = unescapeVcard(value);
    } else if (line.name === 'ORG' && org === null) {
      org = cleanText(components(value)[0] ?? '');
    }
  }
  return collector.result();
}
