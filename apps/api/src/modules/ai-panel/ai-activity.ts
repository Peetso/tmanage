import { findOpById } from '../ai-actions/registry/index.js';
import type { AiActionOp } from '../ai-actions/registry/index.js';
import { subjectNameReadOp, subjectOf } from '../ai-actions/registry/subject.js';
import { ApiError } from '../../common/http/errors.js';
import type { AiActivityCursor } from '../audit/ai-activity.service.js';

/**
 * **The member's own connected-AI activity, the pure half (AI panel gap 1).**
 *
 * The words come from the registry, never from an op id on screen: a read op is "Read", a
 * confirm-class op only froze an approval ("Waiting"), any other op "Changed". A meta-tool with no
 * op (search, describe, check an approval) looked something up: "Read". An op the registry no
 * longer knows reads "Changed", so a removed op is never understated as a read.
 */

export const AI_ACTIVITY_VERBS = ['read', 'changed', 'waiting'] as const;
export type AiActivityVerb = (typeof AI_ACTIVITY_VERBS)[number];

/** One page of the list (Fable ruling: 20 per page, newest first). */
export const AI_ACTIVITY_PAGE_SIZE = 20;

export function verbOf(opId: string | null): AiActivityVerb {
  if (opId === null) return 'read';
  const op = findOpById(opId);
  if (op === undefined) return 'changed';
  if (op.risk === 'read') return 'read';
  return op.risk === 'confirm' ? 'waiting' : 'changed';
}

/** The kind a row is about: the stored one, else the op's declared subject (rows before 11-23). */
export function kindOf(storedKind: string | null, opId: string | null): string | null {
  if (storedKind !== null) return storedKind;
  const op = opId === null ? undefined : findOpById(opId);
  return op === undefined ? null : (subjectOf(op)?.kind ?? null);
}

/** The read to run, and its arguments, to name a row's item; `null` when it cannot be named. */
export interface NameRead {
  readonly op: AiActionOp;
  readonly args: Readonly<Record<string, string>>;
}

/**
 * The registry read that names a stored subject: the item's own `GET` with the subject id as its
 * last path parameter and the project id as `:projectId`. A read needing any other parameter
 * cannot be built from identifiers alone, so the row stays unnamed.
 */
export function nameReadFor(
  opId: string | null,
  targetId: string | null,
  projectId: string | null,
): NameRead | null {
  const op = opId === null ? undefined : findOpById(opId);
  if (op === undefined || targetId === null) return null;
  const read = subjectNameReadOp(op);
  if (read === undefined) return null;
  return readWith(read, targetId, projectId);
}

/** The project read (`projects.get`) for a row's project id. */
export function projectReadFor(projectId: string | null): NameRead | null {
  const read = findOpById('projects.get');
  if (read === undefined || projectId === null) return null;
  return readWith(read, projectId, projectId);
}

function readWith(read: AiActionOp, targetId: string, projectId: string | null): NameRead | null {
  const params = [...read.path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== 'orgSlug');
  const last = params.at(-1);
  if (last === undefined) return null;
  const args: Record<string, string> = {};
  for (const name of params) {
    if (name === last) args[name] = targetId;
    else if (name === 'projectId' && projectId !== null) args[name] = projectId;
    else return null;
  }
  return { op: read, args };
}

const CURSOR = /^(\d{1,15})\.([0-9A-Za-z-]{1,64})$/;

/** The opaque `cursor` of the next page: the last row's time and id. */
export function encodeActivityCursor(cursor: AiActivityCursor): string {
  return Buffer.from(`${cursor.createdAt.getTime()}.${cursor.id}`, 'utf8').toString('base64url');
}

/** The `cursor` query value (IP-2: parsed once at the boundary); 400 when it is not ours. */
export function parseActivityCursor(raw: unknown): AiActivityCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const decoded = typeof raw === 'string' ? Buffer.from(raw, 'base64url').toString('utf8') : '';
  const match = CURSOR.exec(decoded);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ApiError(400, 'validation_failed', 'This page link is not valid.', [
      { field: 'cursor', message: 'use the nextCursor of the page before' },
    ]);
  }
  return { createdAt: new Date(Number(match[1])), id: match[2] };
}
