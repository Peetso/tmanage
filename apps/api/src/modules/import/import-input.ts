/**
 * The untrusted-input boundary for ON-09 import validation.
 *
 * Import parses data a caller supplies, so this is the security surface of the slice: the body
 * is shaped and bounded here, before `validateBatch` sees it. Kept as a pure function (the
 * `upload-input.ts` precedent) so the boundary is unit-testable without standing up HTTP.
 */

import { isImportSourceKind } from './import-validation.js';
import type { ImportSourceKind, SourceMapping, SourceRow } from './import-validation.js';

export interface ValidationDetail {
  readonly field: string;
  readonly message: string;
}

export interface ImportValidationRequest {
  readonly sourceKind: ImportSourceKind;
  readonly mapping: SourceMapping;
  readonly rows: readonly SourceRow[];
}

/**
 * The batch ceiling. A dry-run validation walks every row, so an unbounded batch is an
 * unbounded unit of work on a single request — refused here rather than absorbed. The commit
 * follow-up, which does real writes, will page; this half only needs a sane cap.
 */
export const MAX_IMPORT_ROWS = 1000;

/** True for a plain non-null object (not an array, not `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A mapping is an object whose every value is a source-column name (a string). */
function parseMapping(value: unknown, details: ValidationDetail[]): SourceMapping | undefined {
  if (!isPlainObject(value)) {
    details.push({
      field: 'mapping',
      message: 'must be an object of target field to source column',
    });
    return undefined;
  }
  const mapping: Record<string, string> = {};
  for (const [field, column] of Object.entries(value)) {
    if (typeof column !== 'string') {
      details.push({ field: 'mapping', message: `column for '${field}' must be a string` });
      return undefined;
    }
    mapping[field] = column;
  }
  return mapping;
}

/** Rows must be an array — bounded by {@link MAX_IMPORT_ROWS} — of plain objects. */
function parseRows(value: unknown, details: ValidationDetail[]): readonly SourceRow[] | undefined {
  if (!Array.isArray(value)) {
    details.push({ field: 'rows', message: 'must be an array' });
    return undefined;
  }
  if (value.length > MAX_IMPORT_ROWS) {
    details.push({ field: 'rows', message: `must be ${MAX_IMPORT_ROWS} rows or fewer` });
    return undefined;
  }
  const rows: SourceRow[] = [];
  for (const row of value) {
    if (!isPlainObject(row)) {
      details.push({ field: 'rows', message: 'each row must be an object' });
      return undefined;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse and bound the request body, collecting field errors into `details`. Returns the request
 * only when it is entirely valid — a caller reads `details.length` to tell a rejection from a
 * pass, exactly as the upload boundary does.
 */
export function parseImportValidationBody(
  body: unknown,
  details: ValidationDetail[],
): ImportValidationRequest | undefined {
  const source = isPlainObject(body) ? body : {};

  const sourceKind = source['sourceKind'];
  if (!isImportSourceKind(sourceKind)) {
    details.push({ field: 'sourceKind', message: 'must be a known import source kind' });
  }

  const mapping = parseMapping(source['mapping'], details);
  const rows = parseRows(source['rows'], details);

  if (
    details.length > 0 ||
    !isImportSourceKind(sourceKind) ||
    mapping === undefined ||
    rows === undefined
  ) {
    return undefined;
  }

  return { sourceKind, mapping, rows };
}
