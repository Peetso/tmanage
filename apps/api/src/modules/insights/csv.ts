/**
 * A minimal RFC-4180 CSV writer with a spreadsheet CSV-injection guard.
 *
 * There is no CSV writer elsewhere in the API (files carry their own detected MIME, never a
 * generated table), so this is the one place the two escaping rules live, kept tiny and pure so
 * the export controller stays a thin read → serialise → header:
 *
 * - **RFC-4180 quoting** — a field that contains a comma, a double quote, a CR or an LF is wrapped
 *   in double quotes and each interior quote is doubled, so a value can never split a row or a
 *   record. A field with none of those is emitted verbatim.
 * - **CSV-injection guard** (`26-THREAT-MODELS` §exports / OWASP "CSV injection") — a field whose
 *   first character is one a spreadsheet may read as a formula (`= + - @`, and the `\t`/`\r` that
 *   lead into one) is prefixed with a single quote so the sheet treats it as text, never as
 *   `=cmd|…`. The guard runs *before* the quoting test, so a neutralised value that also needs
 *   quoting still gets both.
 *
 * Records are joined with CRLF and the document ends with a trailing CRLF (RFC-4180 §2.1 permits
 * the final record's line break), so every row — including the last — is terminated.
 */

/** Leading characters a spreadsheet may treat as the start of a formula — the OWASP prefixes. */
const INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** RFC-4180 characters that force a field to be quoted. */
const MUST_QUOTE = /[",\r\n]/;

/** Escape one cell: neutralise a formula prefix, then quote if RFC-4180 requires it. */
export function escapeCsvCell(value: string): string {
  const guarded = INJECTION_PREFIX.test(value) ? `'${value}` : value;
  if (MUST_QUOTE.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

/** Serialise rows to an RFC-4180 document (CRLF-terminated, injection-guarded, with a trailing CRLF). */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  return rows
    .map((row) => row.map((cell) => escapeCsvCell(String(cell))).join(','))
    .map((line) => `${line}\r\n`)
    .join('');
}
