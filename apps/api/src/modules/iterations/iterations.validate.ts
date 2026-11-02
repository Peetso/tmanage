import {
  MAX_BURNDOWN_DAYS,
  MAX_ITERATION_GOAL_LENGTH,
  MAX_ITERATION_ITEMS_PER_CALL,
  MAX_ITERATION_NAME_LENGTH,
  dayNumberOf,
  isIsoDate,
} from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';

/** 53-21 — request-body parsing for the iteration routes. Every failure is a 400 naming the field. */

export function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function record(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('body', 'must be an object');
  }
  return body as Readonly<Record<string, unknown>>;
}

function name(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0 || value.length > MAX_ITERATION_NAME_LENGTH) {
    throw invalid('name', `must be 1 to ${String(MAX_ITERATION_NAME_LENGTH)} characters`);
  }
  return value;
}

function goal(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim().length > MAX_ITERATION_GOAL_LENGTH) {
    throw invalid('goal', `must be at most ${String(MAX_ITERATION_GOAL_LENGTH)} characters`);
  }
  return raw.trim() === '' ? null : raw.trim();
}

function date(raw: unknown, field: string): string {
  if (!isIsoDate(raw)) throw invalid(field, 'must be a YYYY-MM-DD date');
  return raw;
}

function range(startsOn: string, endsOn: string): void {
  const span = dayNumberOf(endsOn) - dayNumberOf(startsOn);
  if (span < 0) throw invalid('endsOn', 'must be on or after startsOn');
  if (span >= MAX_BURNDOWN_DAYS) throw invalid('endsOn', 'an iteration is at most a year long');
}

export interface CreateIterationInput {
  readonly name: string;
  readonly goal: string | null;
  /** Both or neither: omitted, the next free slot is used. */
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

export function parseCreate(body: unknown): CreateIterationInput {
  const b = record(body);
  const startsOn = b['startsOn'] === undefined ? null : date(b['startsOn'], 'startsOn');
  const endsOn = b['endsOn'] === undefined ? null : date(b['endsOn'], 'endsOn');
  if ((startsOn === null) !== (endsOn === null)) {
    throw invalid(startsOn === null ? 'startsOn' : 'endsOn', 'send both dates or neither');
  }
  if (startsOn !== null && endsOn !== null) range(startsOn, endsOn);
  return { name: name(b['name']), goal: goal(b['goal']), startsOn, endsOn };
}

export interface UpdateIterationInput {
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly expectedVersion: number;
}

export function parseUpdate(body: unknown): UpdateIterationInput {
  const b = record(body);
  const expectedVersion = b['expectedVersion'];
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw invalid('expectedVersion', 'must be the version last read');
  }
  const startsOn = date(b['startsOn'], 'startsOn');
  const endsOn = date(b['endsOn'], 'endsOn');
  range(startsOn, endsOn);
  return { name: name(b['name']), goal: goal(b['goal']), startsOn, endsOn, expectedVersion };
}

function ids(raw: unknown, field: string): readonly string[] {
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 64)
  ) {
    throw invalid(field, 'must be a list of work item ids');
  }
  return [...new Set(raw as string[])];
}

export interface MoveItemsInput {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export function parseMoveItems(body: unknown): MoveItemsInput {
  const b = record(body);
  const add = ids(b['add'], 'add');
  const remove = ids(b['remove'], 'remove');
  if (add.length + remove.length === 0) throw invalid('add', 'name at least one work item');
  if (add.length + remove.length > MAX_ITERATION_ITEMS_PER_CALL) {
    throw invalid('add', `at most ${String(MAX_ITERATION_ITEMS_PER_CALL)} ids per call`);
  }
  if (add.some((id) => remove.includes(id))) throw invalid('remove', 'an id is in both lists');
  return { add, remove };
}

export function parseComplete(body: unknown): { readonly moveUnfinishedTo: string | null } {
  const raw = body === undefined || body === null ? undefined : record(body)['moveUnfinishedTo'];
  if (raw === undefined || raw === null) return { moveUnfinishedTo: null };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    throw invalid('moveUnfinishedTo', 'must be an iteration id or null');
  }
  return { moveUnfinishedTo: raw };
}

export function parsePointsSetting(body: unknown): boolean {
  const raw = record(body)['pointsEnabled'];
  if (typeof raw !== 'boolean') throw invalid('pointsEnabled', 'must be true or false');
  return raw;
}
