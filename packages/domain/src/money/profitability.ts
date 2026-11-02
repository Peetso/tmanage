/**
 * 52-14 (R17-a) — profitability and utilisation, pure.
 *
 * Integers only: minutes, minor units of the organization's base currency, and basis points
 * (`10000` bp = 100 %). The API report reads, the CSV export and the worker's nightly facts rebuild
 * all call these, so a margin or a utilisation reads the same on every surface. The SQL rebuild
 * mirrors {@link expenseChargeMinor} and {@link writeOffOf} with the same FLOOR / CASE rules.
 */

/** The longest report range a caller may ask for, in days (inclusive). */
export const FINANCE_REPORT_MAX_DAYS = 366;
/** The window the nightly loop and the on-demand rebuild recompute, in days back from today. */
export const FINANCE_FACTS_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

function dayNumber(isoDay: string): number {
  return Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / DAY_MS);
}

/** Days in `[from, to]`, both inclusive (`YYYY-MM-DD`). 0 when `to` is before `from`. */
export function daysInRange(from: string, to: string): number {
  const days = dayNumber(to) - dayNumber(from) + 1;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * The share of what was billed that is left after cost and expenses, in basis points. Negative is a
 * loss. `null` when nothing was billed — a margin of an empty or written-off range is not 0 %.
 */
export function marginBp(
  billedMinor: number,
  costMinor: number,
  expenseMinor: number,
): number | null {
  if (billedMinor <= 0) return null;
  return Math.round(((billedMinor - costMinor - expenseMinor) / billedMinor) * 10_000);
}

/** Billable minutes as a share of capacity, in basis points. `null` when there is no capacity. */
export function utilisationBp(billableMinutes: number, capacityMinutes: number): number | null {
  if (capacityMinutes <= 0) return null;
  return Math.floor((billableMinutes * 10_000) / capacityMinutes);
}

/**
 * A member's capacity over `[from, to]` from their weekly hours: `weeklyHours × 60 × days / 7`,
 * rounded. The caller honours `person_capacity.effective_from` by clamping `from` to it.
 */
export function capacityMinutes(weeklyHours: number, from: string, to: string): number {
  if (!(weeklyHours > 0)) return 0;
  return Math.round((weeklyHours * 60 * daysInRange(from, to)) / 7);
}

/**
 * The minutes of one entry that are written off: a non-billable entry on a project that bills by
 * default. Non-billable time on a non-billable project is simply internal, not a write-off.
 */
export function writeOffOf(entry: {
  readonly minutes: number;
  readonly billable: boolean;
  readonly projectBillableDefault: boolean | null;
}): number {
  return !entry.billable && entry.projectBillableDefault === true ? entry.minutes : 0;
}

/**
 * What an approved expense adds to a report, in base minor units: its base amount, plus the markup
 * when it is billable (floored, as the SQL rebuild floors). An expense with no base amount (no rate
 * to the base currency yet) counts 0 rather than a figure in the wrong currency.
 */
export function expenseChargeMinor(expense: {
  readonly amountBaseMinor: number | null;
  readonly markupBp: number;
  readonly billable: boolean;
}): number {
  const base = expense.amountBaseMinor ?? 0;
  if (!expense.billable || expense.markupBp <= 0) return base;
  return base + Math.floor((base * expense.markupBp) / 10_000);
}

/** One (day, project, member) group of time entries, as the rebuild's time-log read returns it. */
export interface TimeFactInput {
  readonly day: string;
  /** '' = no project. */
  readonly projectId: string;
  /** The logger's membership (`work_item_time_logs.logged_by`). */
  readonly membershipId: string;
  readonly billableMinutes: number;
  readonly nonbillableMinutes: number;
  readonly writeoffMinutes: number;
  readonly unpricedMinutes: number;
  readonly billedMinor: number;
  readonly costMinor: number;
}

/** One (day, project, member) group of approved or invoiced expenses. */
export interface ExpenseFactInput {
  readonly day: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly expenseMinor: number;
}

/** One `finance_daily_facts` row before it is given an id and a computed-at. */
export interface FinanceFact extends TimeFactInput {
  readonly clientOrganizationId: string | null;
  readonly expenseMinor: number;
  readonly invoicedMinor: number;
  readonly currency: string | null;
}

/**
 * Fold the time-log groups and the expense groups into one row per (day, project, member) — the
 * table's unique grain — and attach the project's client. Sorted by the grain, so two rebuilds of
 * the same sources produce the same rows in the same order (the rebuild is idempotent).
 * `invoicedMinor` is 0 until 52-09 invoices exist.
 */
export function mergeFinanceFacts(input: {
  readonly time: readonly TimeFactInput[];
  readonly expenses: readonly ExpenseFactInput[];
  readonly clientByProject: ReadonlyMap<string, string>;
  readonly currency: string | null;
}): readonly FinanceFact[] {
  const facts = new Map<string, FinanceFact>();
  const keyOf = (r: { day: string; projectId: string; membershipId: string }): string =>
    `${r.day}|${r.projectId}|${r.membershipId}`;
  const empty = (r: { day: string; projectId: string; membershipId: string }): FinanceFact => ({
    day: r.day,
    projectId: r.projectId,
    membershipId: r.membershipId,
    clientOrganizationId:
      r.projectId === '' ? null : (input.clientByProject.get(r.projectId) ?? null),
    billableMinutes: 0,
    nonbillableMinutes: 0,
    writeoffMinutes: 0,
    unpricedMinutes: 0,
    billedMinor: 0,
    costMinor: 0,
    expenseMinor: 0,
    invoicedMinor: 0,
    currency: input.currency,
  });
  for (const t of input.time) {
    const prev = facts.get(keyOf(t)) ?? empty(t);
    facts.set(keyOf(t), {
      ...prev,
      billableMinutes: prev.billableMinutes + t.billableMinutes,
      nonbillableMinutes: prev.nonbillableMinutes + t.nonbillableMinutes,
      writeoffMinutes: prev.writeoffMinutes + t.writeoffMinutes,
      unpricedMinutes: prev.unpricedMinutes + t.unpricedMinutes,
      billedMinor: prev.billedMinor + t.billedMinor,
      costMinor: prev.costMinor + t.costMinor,
    });
  }
  for (const e of input.expenses) {
    const prev = facts.get(keyOf(e)) ?? empty(e);
    facts.set(keyOf(e), { ...prev, expenseMinor: prev.expenseMinor + e.expenseMinor });
  }
  return [...facts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, fact]) => fact);
}
