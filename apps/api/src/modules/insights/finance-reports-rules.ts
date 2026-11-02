import { FINANCE_FACTS_WINDOW_DAYS, FINANCE_REPORT_MAX_DAYS, daysInRange } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { ProfitabilityGroup } from './finance-reports.repository.js';

/**
 * 52-14 (R17-a) — the report routes' input rules, pure. Every refusal is a 422
 * `validation_failed` naming the field.
 */

/** Org setting: `off` hides per-person reports from callers without `finance.manage`. */
export const PERSON_REPORTS_SETTING_KEY = 'finance.person_reports';
/** The on-demand rebuild runs at most once per organization in this window. */
export const REBUILD_COOLDOWN_MS = 5 * 60 * 1000;
/** Rows a profitability or unbilled read returns at most (one per project / client / person). */
export const MAX_REPORT_ROWS = 2_000;
export const UTILISATION_PAGE = 100;

export const PROFITABILITY_GROUPS: readonly ProfitabilityGroup[] = ['project', 'client', 'person'];
export const UNBILLED_GROUPS = ['project', 'client'] as const;
export type UnbilledGroup = (typeof UNBILLED_GROUPS)[number];
export const FINANCE_REPORTS = ['profitability', 'unbilled', 'utilisation'] as const;
export type FinanceReport = (typeof FINANCE_REPORTS)[number];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (field: string, message: string): ApiError =>
  new ApiError(422, 'validation_failed', 'The report request is not valid.', [{ field, message }]);

const iso = (at: Date): string => at.toISOString().slice(0, 10);

function isoDay(value: unknown, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !ISO_DAY.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(field, 'must be a date as YYYY-MM-DD');
  }
  return value;
}

export interface ReportRange {
  readonly from: string;
  readonly to: string;
}

/** `from` / `to` (inclusive). Default: the current UTC month. At most 366 days. */
export function parseRange(from: unknown, to: unknown, now: Date): ReportRange {
  const monthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const monthEnd = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  const range = { from: isoDay(from, 'from') ?? monthStart, to: isoDay(to, 'to') ?? monthEnd };
  if (range.to < range.from) throw invalid('to', 'must not be before from');
  if (daysInRange(range.from, range.to) > FINANCE_REPORT_MAX_DAYS) {
    throw invalid('to', `the range must be at most ${FINANCE_REPORT_MAX_DAYS} days`);
  }
  return range;
}

export function parseChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** The utilisation keyset cursor: the last membership id of the previous page. */
export function parseAfter(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('after', 'must be a member id');
  return value;
}

/** Anything but an explicit `off` keeps per-person reports on (the default). */
export function personReportsEnabled(stored: string | undefined): boolean {
  return stored?.trim().toLowerCase() !== 'off';
}

/** The rebuild window: the last {@link FINANCE_FACTS_WINDOW_DAYS} days up to today (UTC). */
export function rebuildWindow(now: Date): ReportRange {
  const to = iso(now);
  const from = iso(
    new Date(Date.parse(`${to}T00:00:00Z`) - (FINANCE_FACTS_WINDOW_DAYS - 1) * 86_400_000),
  );
  return { from, to };
}

export function rebuildThrottled(lastComputedAt: Date | null, now: Date): boolean {
  return lastComputedAt !== null && now.getTime() - lastComputedAt.getTime() < REBUILD_COOLDOWN_MS;
}

/** The part of `[from, to]` a capacity row covers: it starts no earlier than `effective_from`. */
export function capacityRange(range: ReportRange, effectiveFrom: string): ReportRange | null {
  const from = effectiveFrom > range.from ? effectiveFrom : range.from;
  return from > range.to ? null : { from, to: range.to };
}
