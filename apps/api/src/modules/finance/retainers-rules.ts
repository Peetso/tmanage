import { ApiError } from '../../common/http/errors.js';

/**
 * 52-06 — retainers, the pure half: period maths, rollover, the state machine and input
 * validation. No I/O. The worker's period roll (`apps/worker/src/jobs/retainer-period-roll.ts`)
 * carries the same `periodBounds` / `rolloverIn` (it cannot import this app); UNIT-52-09 pins both.
 *
 * Periods are calendar months or quarters anchored on `starts_on`'s day of the month, clamped to
 * the month's length (an anchor on the 31st starts on 30 April and 28/29 February). Everything is
 * an ISO `YYYY-MM-DD` string: no instants, so no daylight-saving arithmetic.
 */

export const RETAINER_PERIODS = ['monthly', 'quarterly'] as const;
export const ROLLOVER_RULES = ['none', 'cap', 'unlimited'] as const;
export const BILLING_TIMINGS = ['advance', 'arrears'] as const;
export const RETAINER_STATES = ['active', 'paused', 'ended'] as const;

export type RetainerPeriod = (typeof RETAINER_PERIODS)[number];
export type RolloverRule = (typeof ROLLOVER_RULES)[number];
export type BillingTiming = (typeof BILLING_TIMINGS)[number];
export type RetainerState = (typeof RETAINER_STATES)[number];
export type RetainerEvent = 'pause' | 'resume' | 'end';

export const MAX_RETAINER_PROJECTS = 50;
export const MAX_HOURS_PER_PERIOD = 10_000;
export const MAX_ROLLOVER_CAP_MINUTES = MAX_HOURS_PER_PERIOD * 60;
/** Ten years of monthly periods: the periods list never reads more. */
export const MAX_PERIODS_LISTED = 120;
export const ENTRY_PAGE = 50;
export const PORTAL_ENTRY_LIMIT = 100;

export interface PeriodBounds {
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface IndexedPeriod extends PeriodBounds {
  readonly index: number;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): { y: number; m: number; d: number } {
  const match = DAY.exec(day);
  if (match === null) throw new Error(`not an ISO day: ${day}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The anchored start of the period `offsetMonths` months after `startsOn`'s month. */
function anchoredStart(startsOn: string, offsetMonths: number): string {
  const { y, m, d } = parts(startsOn);
  const total = y * 12 + (m - 1) + offsetMonths;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return iso(year, month, Math.min(d, daysInMonth(year, month)));
}

export function addDays(day: string, days: number): string {
  const { y, m, d } = parts(day);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return iso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

export function monthsPerPeriod(period: RetainerPeriod): number {
  return period === 'quarterly' ? 3 : 1;
}

/** The `index`-th period (0 = the one that starts on `startsOn`). */
export function periodBounds(
  startsOn: string,
  period: RetainerPeriod,
  index: number,
): PeriodBounds {
  const step = monthsPerPeriod(period);
  const periodStart = anchoredStart(startsOn, index * step);
  const periodEnd = addDays(anchoredStart(startsOn, (index + 1) * step), -1);
  return { periodStart, periodEnd };
}

/** The period that holds `day`, or `null` when `day` is before `startsOn`. */
export function periodContaining(
  startsOn: string,
  period: RetainerPeriod,
  day: string,
): IndexedPeriod | null {
  if (day < startsOn) return null;
  const from = parts(startsOn);
  const to = parts(day);
  const months = (to.y - from.y) * 12 + (to.m - from.m);
  let index = Math.max(0, Math.floor(months / monthsPerPeriod(period)));
  // The clamp can put `day` one period earlier than the month count says.
  for (;;) {
    const bounds = periodBounds(startsOn, period, index);
    if (day < bounds.periodStart) index -= 1;
    else if (day > bounds.periodEnd) index += 1;
    else return { index, ...bounds };
  }
}

/** The minutes an allowance of `hoursPerPeriod` gives (no hours = no time allowance). */
export function allowanceOf(hoursPerPeriod: number | null): number {
  return hoursPerPeriod === null ? 0 : Math.max(0, hoursPerPeriod) * 60;
}

/** What carries into the next period from what the previous one left unused. */
export function rolloverIn(
  previousRemainingMinutes: number,
  rule: RolloverRule,
  capMinutes: number | null,
): number {
  const remaining = Math.max(0, Math.trunc(previousRemainingMinutes));
  if (rule === 'unlimited') return remaining;
  if (rule === 'cap') return Math.min(remaining, Math.max(0, capMinutes ?? 0));
  return 0;
}

/** Used beyond what the period offers (allowance plus what rolled in); never negative. */
export function overageOf(allowance: number, rolledIn: number, used: number): number {
  return Math.max(0, used - allowance - rolledIn);
}

/** active ⇄ paused, either → ended; ended is final. `null` = the transition is refused. */
export function nextRetainerState(state: string, event: RetainerEvent): RetainerState | null {
  if (event === 'pause') return state === 'active' ? 'paused' : null;
  if (event === 'resume') return state === 'paused' ? 'active' : null;
  return state === 'active' || state === 'paused' ? 'ended' : null;
}

/** Does any day of the period fall inside an open 52-03 lock? */
export function overlapsLock(
  bounds: PeriodBounds,
  locks: readonly { periodStart: string; periodEnd: string; unlockedAt?: Date | null }[],
): boolean {
  return locks.some(
    (lock) =>
      (lock.unlockedAt ?? null) === null &&
      lock.periodStart <= bounds.periodEnd &&
      lock.periodEnd >= bounds.periodStart,
  );
}

/** Minutes as hours to one decimal place, for the client projection. */
export function hoursOf(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

// ---- input validation ----

export interface RetainerInput {
  readonly name: string;
  readonly period: RetainerPeriod;
  readonly hoursPerPeriod: number | null;
  readonly amountPerPeriodMinor: number | null;
  readonly rollover: RolloverRule;
  readonly rolloverCapMinutes: number | null;
  readonly billingTiming: BillingTiming;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly clientVisible: boolean;
  /** `null` = every project linked to the client (`project_clients`). */
  readonly projects: readonly string[] | null;
}

export type RetainerPatch = Partial<
  Pick<
    RetainerInput,
    | 'name'
    | 'hoursPerPeriod'
    | 'amountPerPeriodMinor'
    | 'rollover'
    | 'rolloverCapMinutes'
    | 'clientVisible'
    | 'endsOn'
  >
> & { readonly projects?: readonly string[] };

export function invalid(field: string, message: string): ApiError {
  return new ApiError(422, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

function record(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body', 'must be an object');
  }
  return body as Record<string, unknown>;
}

function oneOf<T extends string>(field: string, raw: unknown, values: readonly T[]): T {
  if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
    throw invalid(field, `must be one of ${values.join(', ')}`);
  }
  return raw as T;
}

function isoDay(field: string, raw: unknown): string {
  if (typeof raw !== 'string' || !DAY.test(raw)) throw invalid(field, 'must be a YYYY-MM-DD date');
  const { y, m, d } = parts(raw);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m))
    throw invalid(field, 'must be a real date');
  return raw;
}

function optionalInt(field: string, raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw invalid(field, `must be a whole number from ${String(min)} to ${String(max)}`);
  }
  return raw;
}

function name(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 1 || value.length > 120) throw invalid('name', 'must be 1 to 120 characters');
  return value;
}

function projectList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || id.length !== 36)) {
    throw invalid('projects', 'must be a list of project ids');
  }
  const unique = [...new Set(raw as string[])];
  if (unique.length < 1 || unique.length > MAX_RETAINER_PROJECTS) {
    throw invalid('projects', `must name 1 to ${String(MAX_RETAINER_PROJECTS)} projects`);
  }
  return unique;
}

/** The terms must agree: some allowance, and a rollover only over hours (a cap needs its size). */
function checkTerms(terms: {
  hoursPerPeriod: number | null;
  amountPerPeriodMinor: number | null;
  rollover: RolloverRule;
  rolloverCapMinutes: number | null;
}): void {
  if (terms.hoursPerPeriod === null && terms.amountPerPeriodMinor === null) {
    throw invalid('hoursPerPeriod', 'hours and/or an amount per period is required');
  }
  if (terms.rollover !== 'none' && terms.hoursPerPeriod === null) {
    throw invalid('rollover', 'a rollover needs hours per period');
  }
  if (terms.rollover === 'cap' && terms.rolloverCapMinutes === null) {
    throw invalid('rolloverCapMinutes', 'a capped rollover needs its cap');
  }
}

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export function validateRetainer(body: unknown): RetainerInput {
  const raw = record(body);
  const rollover =
    raw['rollover'] === undefined ? 'none' : oneOf('rollover', raw['rollover'], ROLLOVER_RULES);
  const input: RetainerInput = {
    name: name(raw['name']),
    period:
      raw['period'] === undefined ? 'monthly' : oneOf('period', raw['period'], RETAINER_PERIODS),
    hoursPerPeriod: optionalInt('hoursPerPeriod', raw['hoursPerPeriod'], 1, MAX_HOURS_PER_PERIOD),
    amountPerPeriodMinor: optionalInt(
      'amountPerPeriodMinor',
      raw['amountPerPeriodMinor'],
      0,
      MAX_MINOR,
    ),
    rollover,
    rolloverCapMinutes:
      rollover === 'cap'
        ? optionalInt('rolloverCapMinutes', raw['rolloverCapMinutes'], 0, MAX_ROLLOVER_CAP_MINUTES)
        : null,
    billingTiming:
      raw['billingTiming'] === undefined
        ? 'advance'
        : oneOf('billingTiming', raw['billingTiming'], BILLING_TIMINGS),
    startsOn: isoDay('startsOn', raw['startsOn']),
    endsOn:
      raw['endsOn'] === undefined || raw['endsOn'] === null
        ? null
        : isoDay('endsOn', raw['endsOn']),
    clientVisible: raw['clientVisible'] === undefined ? true : raw['clientVisible'] === true,
    projects: raw['projects'] === undefined ? null : projectList(raw['projects']),
  };
  if (raw['clientVisible'] !== undefined && typeof raw['clientVisible'] !== 'boolean') {
    throw invalid('clientVisible', 'must be true or false');
  }
  if (input.endsOn !== null && input.endsOn < input.startsOn) {
    throw invalid('endsOn', 'must not be before startsOn');
  }
  checkTerms(input);
  return input;
}

/**
 * A PUT body: every field optional. `period` and `startsOn` are fixed after creation, so naming a
 * different value is refused (the caller passes the stored ones to compare).
 */
export function validateRetainerPatch(
  body: unknown,
  stored: {
    period: string;
    startsOn: string;
    hoursPerPeriod: number | null;
    amountPerPeriodMinor: number | null;
    rollover: string;
    rolloverCapMinutes: number | null;
  },
): RetainerPatch {
  const raw = record(body);
  if (raw['period'] !== undefined && raw['period'] !== stored.period) {
    throw invalid('period', 'cannot change after creation');
  }
  if (raw['startsOn'] !== undefined && raw['startsOn'] !== stored.startsOn) {
    throw invalid('startsOn', 'cannot change after creation');
  }
  const patch: {
    -readonly [K in keyof RetainerPatch]: RetainerPatch[K];
  } = {};
  if (raw['name'] !== undefined) patch.name = name(raw['name']);
  if (raw['hoursPerPeriod'] !== undefined) {
    patch.hoursPerPeriod = optionalInt(
      'hoursPerPeriod',
      raw['hoursPerPeriod'],
      1,
      MAX_HOURS_PER_PERIOD,
    );
  }
  if (raw['amountPerPeriodMinor'] !== undefined) {
    patch.amountPerPeriodMinor = optionalInt(
      'amountPerPeriodMinor',
      raw['amountPerPeriodMinor'],
      0,
      MAX_MINOR,
    );
  }
  if (raw['rollover'] !== undefined)
    patch.rollover = oneOf('rollover', raw['rollover'], ROLLOVER_RULES);
  if (raw['rolloverCapMinutes'] !== undefined) {
    patch.rolloverCapMinutes = optionalInt(
      'rolloverCapMinutes',
      raw['rolloverCapMinutes'],
      0,
      MAX_ROLLOVER_CAP_MINUTES,
    );
  }
  if (raw['clientVisible'] !== undefined) {
    if (typeof raw['clientVisible'] !== 'boolean')
      throw invalid('clientVisible', 'must be true or false');
    patch.clientVisible = raw['clientVisible'];
  }
  if (raw['endsOn'] !== undefined) {
    patch.endsOn = raw['endsOn'] === null ? null : isoDay('endsOn', raw['endsOn']);
    if (patch.endsOn !== null && patch.endsOn < stored.startsOn) {
      throw invalid('endsOn', 'must not be before startsOn');
    }
  }
  if (raw['projects'] !== undefined) patch.projects = projectList(raw['projects']);

  const rollover = (patch.rollover ?? stored.rollover) as RolloverRule;
  checkTerms({
    hoursPerPeriod:
      patch.hoursPerPeriod !== undefined ? patch.hoursPerPeriod : stored.hoursPerPeriod,
    amountPerPeriodMinor:
      patch.amountPerPeriodMinor !== undefined
        ? patch.amountPerPeriodMinor
        : stored.amountPerPeriodMinor,
    rollover,
    rolloverCapMinutes:
      rollover !== 'cap'
        ? null
        : patch.rolloverCapMinutes !== undefined
          ? patch.rolloverCapMinutes
          : stored.rolloverCapMinutes,
  });
  if (rollover !== 'cap' && patch.rollover !== undefined) patch.rolloverCapMinutes = null;
  return patch;
}

/** An entries cursor is the last entry id of the previous page. */
export function cursorOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length !== 36) throw invalid('cursor', 'is not a cursor');
  return raw;
}
