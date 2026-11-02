/**
 * The untrusted-input boundary for ON-09 import validation.
 *
 * Import parses data a caller supplies, so this is the security surface of the slice: the body
 * is shaped and bounded here, before `validateBatch` sees it. Kept as a pure function (the
 * `upload-input.ts` precedent) so the boundary is unit-testable without standing up HTTP.
 */

import { MAX_IMPORT_ROWS, isImportSourceKind } from './import-validation.js';
import type { ImportSourceKind, SourceMapping, SourceRow } from './import-validation.js';
import { isJiraTargetState } from './jira-issues.js';

export { MAX_IMPORT_ROWS };

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
 * R21-e — the Jira commit options. The status / user maps ride in the request rather than in a
 * stored `options_json` (no migration): a second board re-sends its map.
 */
export interface JiraCommitOptions {
  /** The TManage project the issues land in. */
  readonly projectId: string;
  /** Keep `WEB-123` as the item's work key (54-10); needs `project.manage` on the project. */
  readonly keepKeys: boolean;
  /** Jira status name → work state; overrides the status-category default. */
  readonly statusMap: Readonly<Record<string, string>>;
  /** Assignee email (lower-cased) → TManage user id; unmapped assignees import unowned. */
  readonly userMap: Readonly<Record<string, string>>;
}

/** The commit request adds the id of the validated job to the validation shape. */
export interface ImportCommitRequest extends ImportValidationRequest {
  readonly jobId: string;
  /** Present exactly when `sourceKind` is `jira_issues`. */
  readonly jira?: JiraCommitOptions;
}

/** Bounds on the caller-supplied maps: a Jira instance has dozens of statuses, not thousands. */
const MAX_MAP_ENTRIES = 500;
const MAX_MAP_KEY = 320;

/** A job id is a UUID (`CHAR(36)`); shaped here rather than trusted from the body. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Parse and bound the commit request body. The same untrusted-input boundary as
 * {@link parseImportValidationBody}, plus a `jobId` that must be a UUID — the id names the
 * validated job to commit, and a malformed one is refused here rather than turned into a
 * database round-trip.
 */
export function parseImportCommitBody(
  body: unknown,
  details: ValidationDetail[],
): ImportCommitRequest | undefined {
  const source = isPlainObject(body) ? body : {};

  const jobId = source['jobId'];
  if (typeof jobId !== 'string' || !UUID.test(jobId)) {
    details.push({ field: 'jobId', message: 'must be a job id' });
  }

  const request = parseImportValidationBody(source, details);
  const jira =
    source['sourceKind'] === 'jira_issues'
      ? parseJiraOptions(source['options'], details)
      : undefined;

  if (details.length > 0 || request === undefined || typeof jobId !== 'string') {
    return undefined;
  }

  return { jobId, ...request, ...(jira === undefined ? {} : { jira }) };
}

/** A bounded `{ string: string }` map, with each value checked by `valueOk`. */
function parseStringMap(
  field: string,
  value: unknown,
  valueOk: (v: string) => boolean,
  valueMessage: string,
  details: ValidationDetail[],
  lowerKeys = false,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    details.push({ field, message: 'must be an object' });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) {
    details.push({ field, message: `must have ${MAX_MAP_ENTRIES} entries or fewer` });
    return undefined;
  }
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, mapped] of entries) {
    if (key.length > MAX_MAP_KEY || typeof mapped !== 'string' || !valueOk(mapped)) {
      details.push({ field, message: `'${key.slice(0, 60)}' ${valueMessage}` });
      return undefined;
    }
    map[lowerKeys ? key.trim().toLowerCase() : key] = mapped;
  }
  return map;
}

/**
 * `options` for a `jira_issues` commit: `{ projectId, keepKeys?, statusMap?, userMap? }`.
 * `keepKeys` defaults to `true` — keeping `WEB-123` is the point of the importer.
 */
function parseJiraOptions(
  value: unknown,
  details: ValidationDetail[],
): JiraCommitOptions | undefined {
  if (!isPlainObject(value)) {
    details.push({ field: 'options', message: 'must be an object with a projectId' });
    return undefined;
  }
  const projectId = value['projectId'];
  if (typeof projectId !== 'string' || !UUID.test(projectId)) {
    details.push({ field: 'options.projectId', message: 'must be a project id' });
  }
  const keepKeys = value['keepKeys'] ?? true;
  if (typeof keepKeys !== 'boolean') {
    details.push({ field: 'options.keepKeys', message: 'must be a boolean' });
  }
  const statusMap = parseStringMap(
    'options.statusMap',
    value['statusMap'],
    isJiraTargetState,
    'must map to backlog, ready, in_progress, internal_review or done',
    details,
  );
  const userMap = parseStringMap(
    'options.userMap',
    value['userMap'],
    (v) => UUID.test(v),
    'must map to a user id',
    details,
    true,
  );
  if (
    typeof projectId !== 'string' ||
    !UUID.test(projectId) ||
    typeof keepKeys !== 'boolean' ||
    statusMap === undefined ||
    userMap === undefined
  ) {
    return undefined;
  }
  return { projectId, keepKeys, statusMap, userMap };
}
