/**
 * ON-09 — the validate / dry-run half of onboarding import.
 *
 * Governing sources (read-only): `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Onboarding **ON-09**
 * ("Import/migration — source mapping, validation, progress, partial failure") and its admin
 * surface **ADM-10** ("Data import/export — scope, validation, progress, receipt").
 *
 * This module is the pure heart of the slice: given a **source mapping** (which source column
 * carries each target field) and a batch of **source rows**, it validates each row against the
 * target shape and returns a **validation report** — valid count, invalid count, and the exact
 * offending rows. It commits nothing: the caller persists the *attempt* as one `import_jobs`
 * row (the durable anchor for ON-09's "progress" and ADM-10's "receipt"), and the **commit**
 * half that actually creates projects/work from a validated job is the follow-up.
 *
 * ## Partial failure is the point
 *
 * ON-09 names "partial failure" explicitly, so a batch with some invalid rows is **not** an
 * all-or-nothing rejection. Every row is checked; the report lists which rows failed and why,
 * and `status` is `validated_with_errors` rather than a thrown error. A caller can then fix and
 * re-submit only the offending rows.
 */

/**
 * The source kinds this slice understands. One today — `project`, the rows that become projects
 * in the commit half. A closed vocabulary rather than a free string: a new kind is a reviewed
 * addition with its own target rules below, not a value a caller can invent.
 */
export const IMPORT_SOURCE_KINDS = ['project'] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];

export function isImportSourceKind(value: unknown): value is ImportSourceKind {
  return typeof value === 'string' && (IMPORT_SOURCE_KINDS as readonly string[]).includes(value);
}

/** One field-level problem with a source row, named by the **target** field it maps to. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** The problems found in one source row, keyed by its zero-based index in the batch. */
export interface RowValidationError {
  readonly row: number;
  readonly errors: readonly FieldError[];
}

/** A source row as received: opaque columns keyed by their source-column name. */
export type SourceRow = Readonly<Record<string, unknown>>;

/** Which source column carries each target field. `{ targetField: sourceColumn }`. */
export type SourceMapping = Readonly<Record<string, string>>;

/**
 * `validated` — every row passed (including the empty batch: nothing failed).
 * `validated_with_errors` — at least one row failed; the offending rows are listed.
 */
export type ImportValidationStatus = 'validated' | 'validated_with_errors';

export interface ImportValidationReport {
  readonly sourceKind: ImportSourceKind;
  readonly status: ImportValidationStatus;
  readonly totalCount: number;
  readonly validCount: number;
  readonly invalidCount: number;
  /** Only the rows that failed, in batch order. Empty when every row passed. */
  readonly errors: readonly RowValidationError[];
}

/** `projects.name` is `VARCHAR(190)`; the import must not offer a value the column will reject. */
const MAX_PROJECT_NAME_LENGTH = 190;

/**
 * The value a target field resolves to for one row, or `undefined` when the mapping does not
 * name a source column for it or the row omits that column.
 */
function valueFor(field: string, mapping: SourceMapping, row: SourceRow): unknown {
  const column = mapping[field];
  if (column === undefined) return undefined;
  return row[column];
}

/**
 * The target-field values one **validated** `project` row commits as.
 *
 * The commit half re-validates a batch and calls this only for rows that passed, so the two
 * required strings are present and the date, when present, is well-formed. Trimmed to match
 * what {@link requireBoundedString} accepts, so the stored name is the value that was validated
 * rather than one with leading spaces the check ignored.
 */
export interface ProjectCommitValues {
  readonly name: string;
  readonly workspaceId: string;
  /** `YYYY-MM-DD`, or omitted when the row maps no target date. */
  readonly forecastAt?: string;
}

export function projectCommitValues(mapping: SourceMapping, row: SourceRow): ProjectCommitValues {
  const name = String(valueFor('name', mapping, row)).trim();
  const workspaceId = String(valueFor('workspaceId', mapping, row)).trim();
  const rawDate = valueFor('targetDate', mapping, row);
  const forecastAt = typeof rawDate === 'string' && rawDate !== '' ? rawDate : undefined;
  return { name, workspaceId, ...(forecastAt === undefined ? {} : { forecastAt }) };
}

/** A required, non-empty, length-bounded string target field. */
function requireBoundedString(
  field: string,
  value: unknown,
  maxLength: number,
  errors: FieldError[],
): void {
  const text = typeof value === 'string' ? value.trim() : undefined;
  if (text === undefined || text === '') {
    errors.push({ field, message: 'must be a non-empty string' });
    return;
  }
  if (text.length > maxLength) {
    errors.push({ field, message: `must be ${maxLength} characters or fewer` });
  }
}

/**
 * An optional `YYYY-MM-DD` calendar date. Absent is fine; present-but-malformed is an error.
 *
 * Mirrors `ProjectsController.parseTargetDate`: the format is checked and the value is
 * round-tripped so a rolled-over date like `2026-02-31` is rejected rather than silently
 * moved into March.
 */
function checkOptionalDate(field: string, value: unknown, errors: FieldError[]): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push({ field, message: 'must be a date in YYYY-MM-DD form' });
    return;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    errors.push({ field, message: 'is not a real date' });
  }
}

/** Validate one `project` source row against the target shape. */
function validateProjectRow(mapping: SourceMapping, row: SourceRow): readonly FieldError[] {
  const errors: FieldError[] = [];
  requireBoundedString('name', valueFor('name', mapping, row), MAX_PROJECT_NAME_LENGTH, errors);
  requireBoundedString('workspaceId', valueFor('workspaceId', mapping, row), 36, errors);
  checkOptionalDate('targetDate', valueFor('targetDate', mapping, row), errors);
  return errors;
}

const ROW_VALIDATORS: Record<
  ImportSourceKind,
  (mapping: SourceMapping, row: SourceRow) => readonly FieldError[]
> = {
  project: validateProjectRow,
};

/**
 * Validate a batch of source rows against a mapping and return the report.
 *
 * Never throws for invalid data and never mutates a target entity — the report *is* the result.
 * An empty batch is the documented empty value: `validated`, all counts zero, no errors.
 */
export function validateBatch(
  sourceKind: ImportSourceKind,
  mapping: SourceMapping,
  rows: readonly SourceRow[],
): ImportValidationReport {
  const validate = ROW_VALIDATORS[sourceKind];
  const errors: RowValidationError[] = [];

  rows.forEach((row, index) => {
    const rowErrors = validate(mapping, row);
    if (rowErrors.length > 0) errors.push({ row: index, errors: rowErrors });
  });

  const totalCount = rows.length;
  const invalidCount = errors.length;
  const validCount = totalCount - invalidCount;

  return {
    sourceKind,
    status: invalidCount > 0 ? 'validated_with_errors' : 'validated',
    totalCount,
    validCount,
    invalidCount,
    errors,
  };
}
