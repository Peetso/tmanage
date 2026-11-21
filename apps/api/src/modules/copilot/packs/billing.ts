/**
 * 62-29 (plan 62 §9) — the billing assistant over the existing finance routes. Three jobs, no new
 * money path:
 *
 * 1. **Questions with grounded figures.** The pack's reads (invoices, aging, unbilled work,
 *    profitability, budget burn, expenses, the pull preview) are the only source of a figure: the
 *    answer guard (`ai-answer-guard.ts`, 62-12) withholds any amount in the answer that no tool
 *    returned, so a total the model added up itself is shown as "—", never as a fact.
 * 2. **An invoice draft from approved hours.** `client_invoices.create` (an empty draft: an
 *    everyday change, sensitivity `none`, on a card with no step-up and no typed amount, since it
 *    moves no money), then `client_invoices.pull` (approved time, billable expenses, retainer,
 *    quote; `money`) on the 62-11 card. Issuing it is `client_invoices.send`: `money` and `confirm`, so a step-up, the invoice
 *    total typed back, the workspace's approval and a person approving this exact invoice.
 * 3. **An expense with a duplicate check.** `finance.expenses.create` is `money`; before its card
 *    is shown, the member's own visible expenses are read and a likely duplicate is named on the
 *    card ({@link expenseDuplicates}), so the member decides with it in view.
 *
 * The amount the money card names is decided here per op ({@link billingCardAmount}), never by
 * guessing from field names: for a pull it is the draft's total after the pull as the server
 * computes it (`client_invoices.pull_preview`), for an issue the invoice's own total, for an
 * expense its amount. The confirm asks the same
 * question again, so a typed amount that no longer matches is refused (fail closed).
 */

/** The pack: reads first, then the four changes. 8–15 tools (`PACK_MIN_TOOLS`/`PACK_MAX_TOOLS`). */
export const BILLING_PACK_OPS: readonly string[] = [
  'client_invoices.list',
  'client_invoices.get',
  'client_invoices.aging',
  'client_invoices.pull_preview',
  'insights.finance.unbilled',
  'insights.finance.profitability',
  'finance.budget.burn',
  'finance.expenses.list',
  'finance.expenses.get',
  'client_invoices.create',
  'client_invoices.pull',
  'client_invoices.send',
  'finance.expenses.create',
];

/** A read through the member's own surface: the tool result's data, or `null` on a refusal. */
export type BillingRead = (
  opId: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const minorOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A pull's arguments as the preview's query (the same period and kinds). */
export function pullPreviewArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const period = record(args['period']) ?? {};
  const include = record(args['include']) ?? {};
  const quote = record(include['quote']);
  const out: Record<string, unknown> = {
    invoiceId: args['invoiceId'],
    from: period['from'],
    to: period['to'],
  };
  const time = include['time'];
  if (typeof time === 'string') out['time'] = time;
  if (include['expenses'] === true) out['expenses'] = 'true';
  if (include['retainer'] === true) out['retainer'] = 'true';
  if (quote !== null) {
    out['quoteId'] = quote['quoteId'];
    if (typeof quote['depositPercent'] === 'number')
      out['depositPercent'] = quote['depositPercent'];
  }
  return out;
}

/**
 * The amount (minor units) a billing money card names and the member types back; `null` when it
 * cannot be known (the change is then refused at confirm); `undefined` for an op this pack does not
 * decide (the general rule of `ai-preview.ts` applies).
 */
export async function billingCardAmount(
  opId: string,
  args: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>> | null,
  read: BillingRead,
): Promise<number | null | undefined> {
  switch (opId) {
    case 'client_invoices.pull':
      return minorOf(
        record(await read('client_invoices.pull_preview', pullPreviewArgs(args)))?.['totalMinor'],
      );
    case 'client_invoices.send':
    case 'client_invoices.mark_sent':
      return current === null ? null : minorOf(current['totalMinor']);
    case 'finance.expenses.create':
      return minorOf(args['amountMinor']);
    default:
      return undefined;
  }
}

/** Two expenses this many days apart or closer, same amount and currency, may be one cost. */
export const DUPLICATE_DAYS = 3;
/** At most this many duplicates are named on a card. */
export const MAX_DUPLICATES_SHOWN = 3;

export interface CardWarning {
  readonly code: 'possible_duplicate';
  /** The expenses the new one may repeat (ids the member can open). */
  readonly expenseIds: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(at) ? null : Math.round(at / DAY_MS);
};

/**
 * The listed expenses the proposed one may repeat: not rejected, the same receipt file, or the same
 * amount and currency within {@link DUPLICATE_DAYS} days. Pure; `listed` is what the list read
 * returned (`{ expenses: [...] }`), anything else is no candidates.
 */
export function expenseDuplicates(
  args: Readonly<Record<string, unknown>>,
  listed: readonly unknown[],
): readonly string[] {
  const day = dayNumber(args['spentOn']);
  const amount = minorOf(args['amountMinor']);
  const currency = args['currency'];
  const receipt =
    typeof args['receiptFileAssetId'] === 'string' ? args['receiptFileAssetId'] : null;
  const found: string[] = [];
  for (const raw of listed) {
    const other = record(raw);
    if (other === null || typeof other['id'] !== 'string' || other['state'] === 'rejected')
      continue;
    const sameReceipt = receipt !== null && other['receiptFileAssetId'] === receipt;
    const otherDay = dayNumber(other['spentOn']);
    const sameCost =
      amount !== null &&
      other['amountMinor'] === amount &&
      other['currency'] === currency &&
      day !== null &&
      otherDay !== null &&
      Math.abs(day - otherDay) <= DUPLICATE_DAYS;
    if ((sameReceipt || sameCost) && !found.includes(other['id'])) found.push(other['id']);
  }
  return found.slice(0, MAX_DUPLICATES_SHOWN);
}

/** The months (`YYYY-MM`) a ±{@link DUPLICATE_DAYS}-day window around a date touches. */
export function duplicateWindowMonths(spentOn: unknown): readonly string[] {
  const day = dayNumber(spentOn);
  if (day === null) return [];
  const months = new Set<string>();
  for (const offset of [-DUPLICATE_DAYS, 0, DUPLICATE_DAYS]) {
    months.add(new Date((day + offset) * DAY_MS).toISOString().slice(0, 7));
  }
  return [...months];
}

/**
 * The warnings a billing change's card carries: for a new expense, the likely duplicates among the
 * expenses the member may see (read through their own surface, so no one else's are revealed).
 */
export async function billingCardWarnings(
  opId: string,
  args: Readonly<Record<string, unknown>>,
  read: BillingRead,
): Promise<readonly CardWarning[]> {
  if (opId !== 'finance.expenses.create') return [];
  const listed: unknown[] = [];
  for (const period of duplicateWindowMonths(args['spentOn'])) {
    const page = record(await read('finance.expenses.list', { period }));
    const expenses = page?.['expenses'];
    if (Array.isArray(expenses)) listed.push(...(expenses as unknown[]));
  }
  const expenseIds = expenseDuplicates(args, listed);
  return expenseIds.length === 0 ? [] : [{ code: 'possible_duplicate', expenseIds }];
}
