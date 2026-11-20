import { OPS, findOpByRoute, sensitivityOf } from '../ai-actions/registry/index.js';
import type { AiActionOp } from '../ai-actions/registry/index.js';

/**
 * 62-11 part 2 (plan 62 §4.3, J3) — the inverse of an AI change, derived once from the registry's
 * own routes so it cannot drift from what the op does (AR-8: one rule, one place):
 *
 * - **update → restore** (`PATCH /x/:id`): the registry has the read on the same path; the values
 *   of the changed fields are read before the change and written back by the same op.
 * - **create → archive** (`POST /x/`): the created id comes from the answer; the inverse is the
 *   registry's `POST /x/:id/archive`, else its `DELETE /x/:id`.
 *
 * Only everyday changes (sensitivity `none`) have an inverse; money, HR, external and destructive
 * changes always say "cannot be undone" — an e-mail sent or an amount paid is not taken back by a
 * second write. An undo is refused when the record changed since the AI changed it: the marker
 * read right after the change (`updatedAt`, else `version`, else the changed values) must still
 * read the same. The undo window is 15 minutes.
 */

export const AI_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** What an op's inverse is, decided from the registry alone (no call made). */
export type AiInverseSpec =
  | {
      readonly kind: 'restore';
      readonly readOpId: string;
      readonly inverseOpId: string;
    }
  | {
      readonly kind: 'remove';
      readonly readOpId: string;
      readonly inverseOpId: string;
      /** The `:param` of the created record in the read and inverse paths. */
      readonly idParam: string;
    };

const PARAM = /:([A-Za-z0-9_]+)/g;
const MARKER_KEYS = ['updatedAt', 'version'] as const;
/** An optimistic-concurrency token: not data the change sets, and the inverse sends the new one. */
const CONCURRENCY_KEYS = new Set(['version']);

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

function paramsOf(path: string): string[] {
  return [...path.matchAll(PARAM)].map((m) => m[1]!).filter((name) => name !== 'orgSlug');
}

function opsUnder(base: string, method: string, suffix: string): AiActionOp | undefined {
  const pattern = new RegExp(`^${escapeRegExp(base)}/:([A-Za-z0-9_]+)${escapeRegExp(suffix)}/?$`);
  return OPS.find((op) => op.method === method && pattern.test(op.path));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The inverse of an op, or `null` when it has none ("cannot be undone"). */
export function inverseOf(op: AiActionOp): AiInverseSpec | null {
  if (op.risk === 'read' || sensitivityOf(op) !== 'none') return null;
  if (op.method === 'PATCH') {
    const read = findOpByRoute('GET', op.path);
    return read?.risk === 'read'
      ? { kind: 'restore', readOpId: read.id, inverseOpId: op.id }
      : null;
  }
  if (op.method === 'POST') {
    const base = trimSlash(op.path);
    const inverse = opsUnder(base, 'POST', '/archive') ?? opsUnder(base, 'DELETE', '');
    if (inverse === undefined) return null;
    const idParam = paramsOf(inverse.path).at(-1);
    const read = OPS.find(
      (candidate) =>
        candidate.method === 'GET' &&
        candidate.risk === 'read' &&
        trimSlash(candidate.path) === `${base}/:${idParam}`,
    );
    if (idParam === undefined || read === undefined) return null;
    return { kind: 'remove', readOpId: read.id, inverseOpId: inverse.id, idParam };
  }
  return null;
}

/** One change that ran, with what its undo needs: ids and captured values, never argument text. */
export interface AiUndoEntry {
  readonly opId: string;
  readonly readOpId: string;
  readonly readArgs: Readonly<Record<string, unknown>>;
  readonly inverseOpId: string;
  readonly inverseArgs: Readonly<Record<string, unknown>>;
  /** What must still read the same for the undo to run. */
  readonly marker: Readonly<Record<string, unknown>>;
}

type Body = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Body =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The record a read or write answered with (top level, or under `data` / `item`). */
export function recordOf(body: unknown): Body | null {
  if (!isRecord(body)) return null;
  for (const candidate of [body['data'], body['item']]) {
    if (isRecord(candidate) && typeof candidate['id'] === 'string') return candidate;
  }
  return body;
}

/** The path arguments of `path` taken from `args`. */
export function pathArgsOf(path: string, args: Readonly<Record<string, unknown>>): Body {
  return Object.fromEntries(paramsOf(path).map((name) => [name, args[name]]));
}

/** The body fields an update changes: its arguments that are not path or concurrency arguments. */
export function changedFields(op: AiActionOp, args: Readonly<Record<string, unknown>>): string[] {
  const path = new Set(paramsOf(op.path));
  return Object.keys(args).filter(
    (key) => !path.has(key) && key !== 'orgSlug' && !CONCURRENCY_KEYS.has(key),
  );
}

function markerOf(record: Body | null, fields: readonly string[]): Body | null {
  if (record === null) return null;
  for (const key of MARKER_KEYS) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return { [key]: value };
  }
  if (fields.length === 0 || fields.some((field) => !(field in record))) return null;
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

/**
 * The undo of one change that ran, from what was read around it: `before` (the target read
 * before an update), `answer` (the write's own answer) and `after` (the target read after it).
 * `null` when anything it needs is missing: the change then cannot be undone.
 */
export function captureUndo(
  op: AiActionOp,
  spec: AiInverseSpec | null,
  args: Readonly<Record<string, unknown>>,
  reads: { readonly before: unknown; readonly answer: unknown; readonly after: unknown },
): AiUndoEntry | null {
  if (spec === null) return null;
  if (spec.kind === 'restore') {
    const fields = changedFields(op, args);
    const before = recordOf(reads.before);
    if (before === null || fields.length === 0 || fields.some((f) => !(f in before))) return null;
    const readArgs = pathArgsOf(op.path, args);
    const after = recordOf(reads.after);
    const marker = markerOf(after, fields);
    if (marker === null) return null;
    // The inverse carries the record's version as the change left it (else it would conflict).
    const concurrency: Record<string, unknown> = {};
    for (const key of Object.keys(args).filter((k) => CONCURRENCY_KEYS.has(k))) {
      if (after?.[key] === undefined) return null;
      concurrency[key] = after[key];
    }
    return {
      opId: op.id,
      readOpId: spec.readOpId,
      readArgs,
      inverseOpId: spec.inverseOpId,
      inverseArgs: {
        ...readArgs,
        ...Object.fromEntries(fields.map((f) => [f, before[f] ?? null])),
        ...concurrency,
      },
      marker,
    };
  }
  const created = recordOf(reads.answer);
  const id = created?.['id'];
  if (typeof id !== 'string' || id === '') return null;
  const readArgs = { ...pathArgsOf(op.path, args), [spec.idParam]: id };
  const marker = markerOf(recordOf(reads.after) ?? created, []);
  if (marker === null) return null;
  return {
    opId: op.id,
    readOpId: spec.readOpId,
    readArgs,
    inverseOpId: spec.inverseOpId,
    inverseArgs: readArgs,
    marker,
  };
}

/** The record changed since the AI changed it (or is gone): the undo is refused. */
export function changedSince(entry: AiUndoEntry, current: unknown): boolean {
  const record = recordOf(current);
  if (record === null) return true;
  return Object.entries(entry.marker).some(([key, value]) => !sameValue(record[key], value));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Within the 15 minutes of the change. */
export function withinUndoWindow(doneAt: Date, now: Date): boolean {
  const elapsed = now.getTime() - doneAt.getTime();
  return elapsed >= 0 && elapsed <= AI_UNDO_WINDOW_MS;
}
