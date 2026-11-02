import { currencyDigits, divideHalfUp, isUuid } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { FINANCE_CURRENCIES, invalid } from './finance-rules.js';
import { isoDate } from './rates-rules.js';

/**
 * 52-07 — the pure half of expenses: the state machine (UNIT-52-10), body and query validation,
 * the base-currency conversion and the auto-approve threshold. No I/O here.
 *
 * Capability stand-ins (no `capabilities.ts` edit this pass): `expense.submit` = `work.read` plus
 * an internal principal (as `TIME_TRACK_OWN`); `expense.approve` = `project.manage` on the
 * expense's project, or `finance.manage` when it has none; `expense.view_all` and the export =
 * `finance.manage`.
 */

export const EXPENSE_STATES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'invoiced',
  'locked',
] as const;
export type ExpenseState = (typeof EXPENSE_STATES)[number];

export const EXPENSE_CATEGORIES = [
  'Ads',
  'Software',
  'Travel',
  'Print',
  'Freelancer',
  'Other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type ExpenseEvent = 'edit' | 'submit' | 'approve' | 'reject' | 'delete';

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;
/** 100 %: a higher markup needs `finance.manage` (rounding / markup abuse, 52-07 Security). */
export const MARKUP_CAP_BP = 10_000;
export const MARKUP_FINANCE_MAX_BP = 100_000;
export const DEFAULT_AUTO_APPROVE_UNDER_MINOR = 50_000;
export const AUTO_APPROVE_SETTING_KEY = 'expense.auto_approve_under_minor';
export const DUPLICATE_WINDOW_DAYS = 90;
export const EXPENSE_PAGE = 50;
export const MAX_EXPORT_ROWS = 5_000;

/**
 * The state after `event`, or `null` when the event is not allowed from `state`. `invoiced` and
 * `locked` are reached only by 52-09 paths and accept nothing here. An edit keeps the state: the
 * service bumps `version` when the money changes on a submitted row (it stays submitted, so the
 * approver decides on the new amount).
 */
export function nextExpenseState(state: string, event: ExpenseEvent): ExpenseState | null {
  switch (event) {
    case 'edit':
      return state === 'draft' || state === 'submitted' || state === 'rejected' ? state : null;
    case 'submit':
      return state === 'draft' || state === 'rejected' ? 'submitted' : null;
    case 'approve':
      return state === 'submitted' ? 'approved' : null;
    case 'reject':
      return state === 'submitted' ? 'rejected' : null;
    case 'delete':
      return state === 'draft' ? 'draft' : null;
  }
}

export function refuseTransition(state: string, event: ExpenseEvent): ApiError {
  return new ApiError(409, 'conflict', `An expense in state ${state} cannot ${event}.`, [
    { field: 'state', message: `invalid_transition:${state}->${event}` },
  ]);
}

/** Auto-approval: strictly under the threshold, in base-currency minor units. */
export function autoApproves(amountBaseMinor: number, thresholdMinor: number): boolean {
  return amountBaseMinor < thresholdMinor;
}

/** The stored setting, or the default when absent or not a whole number >= 0. */
export function parseThreshold(value: string | undefined): number {
  if (value === undefined || !/^\d{1,15}$/u.test(value.trim()))
    return DEFAULT_AUTO_APPROVE_UNDER_MINOR;
  return Number(value.trim());
}

/**
 * `amountMinor` (in `from`) as base-currency minor units at `rate` (a decimal string, base per one
 * `from`), half away from zero, across the two currencies' minor digits.
 */
export function toBaseMinor(amountMinor: number, from: string, base: string, rate: string): number {
  if (!/^\d{1,10}(\.\d{1,8})?$/u.test(rate)) throw new Error('rate must be a decimal string');
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(8, '0'));
  const shift = currencyDigits(base) - currencyDigits(from);
  let numerator = BigInt(amountMinor) * scaled;
  let denominator = 100_000_000n;
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  if (shift < 0) denominator *= 10n ** BigInt(-shift);
  return Number(divideHalfUp(numerator, denominator));
}

export function fxRateMissing(currency: string, base: string): ApiError {
  return new ApiError(
    422,
    'validation_failed',
    `No exchange rate from ${currency} to ${base}; add one in Settings → Finance.`,
    [{ field: 'currency', message: 'fx_rate_missing' }],
  );
}

export interface ExpenseInput {
  readonly projectId: string | null;
  readonly spentOn: string;
  readonly category: ExpenseCategory;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billable: boolean | null;
  readonly markupBp: number;
  readonly taxBp: number;
  readonly note: string | null;
  readonly receiptFileAssetId: string | null;
}

export type ExpensePatch = Partial<ExpenseInput>;

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalid('body', 'must be an object');
  return body as Record<string, unknown>;
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw invalid(field, `must be a whole number from ${min} to ${max}`);
  return value;
}

function nullableId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !isUuid(value)) throw invalid(field, 'must be an id');
  return value;
}

export function noteText(value: unknown, field: string, min: number): string | null {
  if ((value === null || value === undefined) && min === 0) return null;
  if (typeof value !== 'string') throw invalid(field, 'must be text');
  const trimmed = value.trim();
  if (trimmed === '' && min === 0) return null;
  if (trimmed.length < min || trimmed.length > 500)
    throw invalid(field, `must be ${Math.max(min, 1)} to 500 characters`);
  return trimmed;
}

function field<K extends keyof ExpenseInput>(
  input: Record<string, unknown>,
  key: K,
  canExceedMarkup: boolean,
): ExpenseInput[K] {
  const value = input[key];
  switch (key) {
    case 'projectId':
    case 'receiptFileAssetId':
      return nullableId(value, key) as ExpenseInput[K];
    case 'spentOn':
      return isoDate(value, key) as ExpenseInput[K];
    case 'category': {
      const found = EXPENSE_CATEGORIES.find((c) => c === value);
      if (found === undefined)
        throw invalid(key, `must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
      return found as ExpenseInput[K];
    }
    case 'amountMinor':
      return whole(value, key, 1, MAX_AMOUNT_MINOR) as ExpenseInput[K];
    case 'currency': {
      const found = FINANCE_CURRENCIES.find((c) => c === value);
      if (found === undefined) throw invalid(key, 'must be a supported currency');
      return found as ExpenseInput[K];
    }
    case 'billable':
      if (value === null || value === undefined) return null as ExpenseInput[K];
      if (typeof value !== 'boolean') throw invalid(key, 'must be true or false');
      return value as ExpenseInput[K];
    case 'markupBp':
      if (value === undefined) return 0 as ExpenseInput[K];
      return whole(
        value,
        key,
        0,
        canExceedMarkup ? MARKUP_FINANCE_MAX_BP : MARKUP_CAP_BP,
      ) as ExpenseInput[K];
    case 'taxBp':
      if (value === undefined) return 0 as ExpenseInput[K];
      return whole(value, key, 0, 10_000) as ExpenseInput[K];
    case 'note':
      return noteText(value, key, 0) as ExpenseInput[K];
  }
  throw invalid(String(key), 'is not a field');
}

const FIELDS: readonly (keyof ExpenseInput)[] = [
  'projectId',
  'spentOn',
  'category',
  'amountMinor',
  'currency',
  'billable',
  'markupBp',
  'taxBp',
  'note',
  'receiptFileAssetId',
];

/** A POST body. `state` is `draft` or `submitted` (the default). */
export function validateExpense(
  body: unknown,
  canExceedMarkup: boolean,
): ExpenseInput & { readonly submit: boolean } {
  const input = record(body);
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) out[key] = field(input, key, canExceedMarkup);
  const state = input['state'] ?? 'submitted';
  if (state !== 'draft' && state !== 'submitted')
    throw invalid('state', 'must be draft or submitted');
  return { ...(out as unknown as ExpenseInput), submit: state === 'submitted' };
}

/** A PUT body: only the named fields change. */
export function validateExpensePatch(body: unknown, canExceedMarkup: boolean): ExpensePatch {
  const input = record(body);
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) if (key in input) out[key] = field(input, key, canExceedMarkup);
  if (Object.keys(out).length === 0) throw invalid('body', 'names no field to change');
  return out as ExpensePatch;
}

export interface ExpenseQuery {
  readonly from: string | null;
  readonly to: string | null;
  readonly projectId: string | null;
  readonly state: ExpenseState | null;
  readonly billable: boolean | null;
  readonly cursor: string | null;
}

/** `period` is a month `YYYY-MM`; the rest are optional filters. */
export function validateQuery(query: Record<string, unknown>): ExpenseQuery {
  const period = query['period'];
  let from: string | null = null;
  let to: string | null = null;
  if (period !== undefined) {
    if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(period))
      throw invalid('period', 'must be YYYY-MM');
    const [y, m] = period.split('-').map(Number) as [number, number];
    from = `${period}-01`;
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  const state = query['state'];
  if (state !== undefined && !EXPENSE_STATES.includes(state as ExpenseState))
    throw invalid('state', `must be one of ${EXPENSE_STATES.join(', ')}`);
  const billable = query['billable'];
  if (billable !== undefined && billable !== 'true' && billable !== 'false')
    throw invalid('billable', 'must be true or false');
  return {
    from,
    to,
    projectId: nullableId(query['projectId'], 'projectId'),
    state: (state as ExpenseState | undefined) ?? null,
    billable: billable === undefined ? null : billable === 'true',
    cursor: nullableId(query['cursor'], 'cursor'),
  };
}
