import { currencyDigits, divideHalfUp, expenseChargeMinor } from '@tmanage/domain';
import { expenseCategoryAr } from './client-invoices-rules.js';
import type { LineUnit, SourceType, TimeGrouping } from './client-invoices-rules.js';

/**
 * 52-09 — the pull-in, pure half: approved time, approved billable expenses, a retainer fee and a
 * quote's fixed lines turned into draft lines. The repository reads the sources (approved
 * timesheets only, `invoice_line_id IS NULL`, the client's projects, the period); this file only
 * groups and prices them. Each pulled line carries the ids it stands for, linked at send.
 *
 * Time is priced at the entry's `rate_snapshot_minor` (per hour, base currency): grouped by task,
 * person, day or as one line, and split further by rate so a line has one unit price. An entry
 * without a rate snapshot is never priced at zero — it is left out and reported as `unpricedMinutes`.
 * Amounts in the base currency are converted at the invoice's frozen FX rate.
 */

export interface PulledLine {
  readonly sourceType: SourceType;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly quantityCenti: number;
  readonly unit: LineUnit;
  readonly unitPriceMinor: number;
  readonly discountBp: number;
  readonly taxBp: number;
  readonly groupKey: string | null;
  readonly sourceIds: readonly string[];
}

export interface PullTimeRow {
  readonly id: string;
  readonly minutes: number;
  readonly spentOn: string;
  readonly rateMinor: number | null;
  readonly workItemId: string | null;
  readonly title: string | null;
  readonly membershipId: string;
  /** The first word of the member's display name; never more. */
  readonly firstName: string | null;
  /**
   * 2026-11-23 time trust: typed in or corrected (approved), not measured by the timer. Such time
   * is invoiced on its own line, labelled "added by hand", so the client sees which hours were
   * measured. Absent = measured.
   */
  readonly byHand?: boolean;
}

/** The label a hand-added time line carries on the invoice (both languages). */
export const HAND_TIME_LINE_EN = ' (added by hand)';
export const HAND_TIME_LINE_AR = ' (أُضيف يدويًا)';

export interface PullExpenseRow {
  readonly id: string;
  readonly spentOn: string;
  readonly category: string;
  readonly amountBaseMinor: number | null;
  readonly markupBp: number;
  readonly billable: boolean;
  readonly taxBp: number;
}

export interface PullRetainer {
  readonly periodId: string;
  readonly name: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountPerPeriodMinor: number;
}

export interface PullQuote {
  readonly number: string;
  readonly lines: readonly {
    readonly description: string;
    readonly unit: string;
    readonly quantityCenti: number;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly lineNetMinor: number;
  }[];
}

/** A base-currency amount in the invoice currency: × rate, digits adjusted, half-up. */
export function convertMinor(
  amountBaseMinor: number,
  fxRate: string | null,
  baseCurrency: string,
  invoiceCurrency: string,
): number {
  if (fxRate === null || baseCurrency === invoiceCurrency) return amountBaseMinor;
  const [whole = '0', fraction = ''] = fxRate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(8, '0').slice(0, 8));
  const shift = currencyDigits(invoiceCurrency) - currencyDigits(baseCurrency);
  let numerator = BigInt(amountBaseMinor) * scaled;
  let denominator = 100_000_000n;
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  if (shift < 0) denominator *= 10n ** BigInt(-shift);
  return Number(divideHalfUp(numerator, denominator));
}

/** Minutes → hours in hundredths, half-up (90 min = 150). */
export function centiHours(minutes: number): number {
  return Number(divideHalfUp(BigInt(minutes) * 100n, 60n));
}

const UNSORTED_EN = 'Professional services';
const UNSORTED_AR = 'خدمات مهنية';

function timeGroup(
  row: PullTimeRow,
  grouping: TimeGrouping,
  periodStart: string,
  periodEnd: string,
): { key: string; en: string; ar: string } {
  switch (grouping) {
    case 'by_task':
      return row.workItemId === null || row.title === null
        ? { key: 'task:none', en: UNSORTED_EN, ar: UNSORTED_AR }
        : { key: `task:${row.workItemId}`, en: row.title, ar: row.title };
    case 'by_person': {
      const name = row.firstName ?? '';
      return {
        key: `person:${row.membershipId}`,
        en: name === '' ? UNSORTED_EN : `${UNSORTED_EN} — ${name}`,
        ar: name === '' ? UNSORTED_AR : `${UNSORTED_AR} — ${name}`,
      };
    }
    case 'by_day':
      return {
        key: `day:${row.spentOn}`,
        en: `${UNSORTED_EN} — ${row.spentOn}`,
        ar: `${UNSORTED_AR} — ${row.spentOn}`,
      };
    case 'single':
      return {
        key: 'single',
        en: `${UNSORTED_EN} ${periodStart} – ${periodEnd}`,
        ar: `${UNSORTED_AR} ${periodStart} – ${periodEnd}`,
      };
  }
}

export function timeLines(
  rows: readonly PullTimeRow[],
  options: {
    readonly grouping: TimeGrouping;
    readonly taxBp: number;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly convert: (amountBaseMinor: number) => number;
  },
): { readonly lines: readonly PulledLine[]; readonly unpricedMinutes: number } {
  let unpricedMinutes = 0;
  const groups = new Map<
    string,
    { en: string; ar: string; rate: number; minutes: number; ids: string[] }
  >();
  for (const row of rows) {
    if (row.rateMinor === null) {
      unpricedMinutes += row.minutes;
      continue;
    }
    const group = timeGroup(row, options.grouping, options.periodStart, options.periodEnd);
    const hand = row.byHand === true;
    const key = `${group.key}${hand ? '#hand' : ''}|${String(row.rateMinor)}`;
    const slot = groups.get(key) ?? {
      en: hand ? `${group.en}${HAND_TIME_LINE_EN}` : group.en,
      ar: hand ? `${group.ar}${HAND_TIME_LINE_AR}` : group.ar,
      rate: row.rateMinor,
      minutes: 0,
      ids: [],
    };
    slot.minutes += row.minutes;
    slot.ids.push(row.id);
    groups.set(key, slot);
  }
  const lines: PulledLine[] = [];
  for (const [key, slot] of groups) {
    if (slot.minutes <= 0) continue;
    lines.push({
      sourceType: 'time',
      descriptionEn: slot.en.slice(0, 500),
      descriptionAr: slot.ar.slice(0, 500),
      quantityCenti: centiHours(slot.minutes),
      unit: 'hour',
      unitPriceMinor: options.convert(slot.rate),
      discountBp: 0,
      taxBp: options.taxBp,
      groupKey: key.split('|')[0]!.slice(0, 64),
      sourceIds: slot.ids,
    });
  }
  return { lines, unpricedMinutes };
}

export function expenseLines(
  rows: readonly PullExpenseRow[],
  convert: (amountBaseMinor: number) => number,
): readonly PulledLine[] {
  return rows
    .filter((row) => row.billable && row.amountBaseMinor !== null)
    .map((row) => ({
      sourceType: 'expense' as const,
      descriptionEn: `Expense — ${row.category} (${row.spentOn})`,
      descriptionAr: `مصروف — ${expenseCategoryAr(row.category)} (${row.spentOn})`,
      quantityCenti: 100,
      unit: 'item' as const,
      unitPriceMinor: convert(expenseChargeMinor(row)),
      discountBp: 0,
      taxBp: row.taxBp,
      groupKey: 'expense',
      sourceIds: [row.id],
    }));
}

export function retainerLine(
  retainer: PullRetainer,
  taxBp: number,
  convert: (amountBaseMinor: number) => number,
): PulledLine {
  const span = `${retainer.periodStart} – ${retainer.periodEnd}`;
  return {
    sourceType: 'retainer',
    descriptionEn: `Retainer fee: ${retainer.name} (${span})`.slice(0, 500),
    descriptionAr: `رسوم عقد الخدمة: ${retainer.name} (${span})`.slice(0, 500),
    quantityCenti: 100,
    unit: 'month',
    unitPriceMinor: convert(retainer.amountPerPeriodMinor),
    discountBp: 0,
    taxBp,
    groupKey: 'retainer',
    sourceIds: [retainer.periodId],
  };
}

const LINE_UNIT_SET: ReadonlySet<string> = new Set(['item', 'hour', 'day', 'month', 'fixed']);

/**
 * A quote's fixed lines (standard / final invoices), or — for a deposit invoice — one line per tax
 * rate carrying `depositBp` of the quote's net at that rate.
 */
export function quoteLines(quote: PullQuote, depositBp: number | null): readonly PulledLine[] {
  const groupKey = `quote:${quote.number}`.slice(0, 64);
  if (depositBp === null) {
    return quote.lines.map((line) => ({
      sourceType: 'quote' as const,
      descriptionEn: line.description,
      descriptionAr: line.description,
      quantityCenti: line.quantityCenti,
      unit: (LINE_UNIT_SET.has(line.unit) ? line.unit : 'item') as LineUnit,
      unitPriceMinor: line.unitPriceMinor,
      discountBp: 0,
      taxBp: line.taxBp,
      groupKey,
      sourceIds: [],
    }));
  }
  const byRate = new Map<number, bigint>();
  for (const line of quote.lines) {
    byRate.set(line.taxBp, (byRate.get(line.taxBp) ?? 0n) + BigInt(line.lineNetMinor));
  }
  const percent = String(depositBp / 100);
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([taxBp, net]) => ({
      sourceType: 'quote' as const,
      descriptionEn: `Deposit ${percent}% — quote ${quote.number}`,
      descriptionAr: `دفعة مقدمة ${percent}% — عرض السعر ${quote.number}`,
      quantityCenti: 100,
      unit: 'fixed' as const,
      unitPriceMinor: Number(divideHalfUp(net * BigInt(depositBp), 10_000n)),
      discountBp: 0,
      taxBp,
      groupKey,
      sourceIds: [],
    }));
}
