import {
  MoneyError,
  computeLineTax,
  divideHalfUp,
  lineNetFromQuantity,
  sumLines,
} from './money.js';

/**
 * 52-09 — the pure maths of a client invoice (spec 52 §7): line amounts with a per-line discount,
 * tax per rate, totals, the amount due after payments and an applied deposit, payments moving the
 * state, the aging bucket of an open invoice, and credit-note totals.
 *
 * Integer minor units throughout (`money.ts`): a line's gross is `qty × unit price` rounded half-up,
 * its discount is rounded half-up at the line, tax is computed on the discounted net and rounded at
 * the line, and the document totals are sums of the rounded lines — never re-rounded.
 */

export const INVOICE_STATES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'void',
  'credited',
] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const INVOICE_KINDS = ['standard', 'simplified', 'deposit', 'final'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_LANGUAGES = ['en', 'ar', 'bi'] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

export const PAYMENT_METHODS = ['transfer', 'cash', 'cheque', 'card_offline'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const AGING_BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** What a line contributes: quantity in hundredths (150 = 1.5), prices in minor units. */
export interface InvoiceLineInput {
  readonly quantityCenti: number;
  readonly unitPriceMinor: number;
  /** Per-line discount in basis points; falls back to the document's `discountBp`. */
  readonly discountBp?: number;
  readonly taxBp: number;
}

export interface InvoiceLineAmounts {
  /** `qty × unit price`, before the discount. */
  readonly lineGrossBeforeDiscountMinor: number;
  readonly lineDiscountMinor: number;
  /** After the discount: what tax is computed on. */
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  /** Net + tax. */
  readonly lineGrossMinor: number;
}

export interface TaxRateTotal {
  readonly taxBp: number;
  readonly netMinor: number;
  readonly taxMinor: number;
}

export interface InvoiceTotals {
  readonly lines: readonly InvoiceLineAmounts[];
  /** Sum of the lines before discount. */
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  /** Subtotal − discount + tax. */
  readonly totalMinor: number;
  /** One row per tax rate, ascending by rate. */
  readonly taxByRate: readonly TaxRateTotal[];
  readonly depositAppliedMinor: number;
  readonly paidMinor: number;
  /** Total − paid − deposit, never below zero. */
  readonly amountDueMinor: number;
}

function bp(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new MoneyError(`${what} must be a whole number from 0 to 10000`);
  }
  return value;
}

export function invoiceLineAmounts(
  line: InvoiceLineInput,
  documentDiscountBp = 0,
): InvoiceLineAmounts {
  const gross = lineNetFromQuantity(line.quantityCenti, line.unitPriceMinor);
  const discountBp = bp(line.discountBp ?? documentDiscountBp, 'discountBp');
  const discount = Number(divideHalfUp(BigInt(gross) * BigInt(discountBp), 10_000n));
  const taxed = computeLineTax(gross - discount, line.taxBp);
  return {
    lineGrossBeforeDiscountMinor: gross,
    lineDiscountMinor: discount,
    lineNetMinor: taxed.lineNetMinor,
    lineTaxMinor: taxed.lineTaxMinor,
    lineGrossMinor: taxed.lineGrossMinor,
  };
}

export function invoiceTotals(
  lines: readonly InvoiceLineInput[],
  options: {
    readonly discountBp?: number;
    readonly depositAppliedMinor?: number;
    readonly paidMinor?: number;
  } = {},
): InvoiceTotals {
  const amounts = lines.map((line) => invoiceLineAmounts(line, options.discountBp ?? 0));
  const sums = sumLines(amounts);
  let subtotal = 0n;
  let discount = 0n;
  const byRate = new Map<number, { net: bigint; tax: bigint }>();
  amounts.forEach((amount, index) => {
    subtotal += BigInt(amount.lineGrossBeforeDiscountMinor);
    discount += BigInt(amount.lineDiscountMinor);
    const rate = lines[index]!.taxBp;
    const slot = byRate.get(rate) ?? { net: 0n, tax: 0n };
    slot.net += BigInt(amount.lineNetMinor);
    slot.tax += BigInt(amount.lineTaxMinor);
    byRate.set(rate, slot);
  });
  const deposit = options.depositAppliedMinor ?? 0;
  const paid = options.paidMinor ?? 0;
  const total = sums.grossMinor;
  return {
    lines: amounts,
    subtotalMinor: Number(subtotal),
    discountMinor: Number(discount),
    taxMinor: sums.taxMinor,
    totalMinor: total,
    taxByRate: [...byRate.entries()]
      .sort(([a], [b]) => a - b)
      .map(([taxBp, slot]) => ({ taxBp, netMinor: Number(slot.net), taxMinor: Number(slot.tax) })),
    depositAppliedMinor: deposit,
    paidMinor: paid,
    amountDueMinor: Math.max(0, total - paid - deposit),
  };
}

/** The open amount of an issued invoice. */
export function amountDue(invoice: {
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly depositAppliedMinor: number;
}): number {
  return Math.max(0, invoice.totalMinor - invoice.paidMinor - invoice.depositAppliedMinor);
}

export type PaymentOutcome =
  | { readonly ok: true; readonly state: InvoiceState; readonly paidMinor: number }
  | { readonly ok: false; readonly error: 'invalid_state' | 'invalid_amount' | 'overpayment' };

const PAYABLE: ReadonlySet<InvoiceState> = new Set(['sent', 'partially_paid']);

/**
 * A payment on an issued invoice: sent → partially_paid → paid. Above the amount due it is an
 * `overpayment` unless the organization allows one (the invoice then reads paid).
 */
export function applyPayment(
  invoice: {
    readonly state: InvoiceState;
    readonly totalMinor: number;
    readonly paidMinor: number;
    readonly depositAppliedMinor: number;
  },
  amountMinor: number,
  allowOverpayment: boolean,
): PaymentOutcome {
  if (!PAYABLE.has(invoice.state)) return { ok: false, error: 'invalid_state' };
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }
  if (amountMinor > amountDue(invoice) && !allowOverpayment) {
    return { ok: false, error: 'overpayment' };
  }
  const paidMinor = invoice.paidMinor + amountMinor;
  const settled = paidMinor + invoice.depositAppliedMinor >= invoice.totalMinor;
  return { ok: true, state: settled ? 'paid' : 'partially_paid', paidMinor };
}

export type InvoiceEvent = 'send' | 'void' | 'credit_full';

const TRANSITIONS: Readonly<
  Record<InvoiceEvent, Readonly<Partial<Record<InvoiceState, InvoiceState>>>>
> = {
  send: { draft: 'sent' },
  void: { draft: 'void' },
  credit_full: { sent: 'credited', partially_paid: 'credited', paid: 'credited' },
};

/** The state an event moves an invoice to, or `null` when it may not. Payments: `applyPayment`. */
export function nextInvoiceState(state: InvoiceState, event: InvoiceEvent): InvoiceState | null {
  return TRANSITIONS[event][state] ?? null;
}

/** Whether a credit note may be issued against an invoice in this state. */
export function isCreditable(state: InvoiceState): boolean {
  return state === 'sent' || state === 'partially_paid' || state === 'paid';
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) throw new MoneyError(`not a date: ${date}`);
  return Math.floor(at / DAY_MS);
}

/** Days past due (≤ 0 when not yet due) → 0–30 | 31–60 | 61–90 | 90+. */
export function agingBucket(dueDate: string, today: string): AgingBucket {
  const overdue = dayNumber(today) - dayNumber(dueDate);
  if (overdue <= 30) return '0_30';
  if (overdue <= 60) return '31_60';
  if (overdue <= 90) return '61_90';
  return '90_plus';
}

export interface CreditNoteTotals {
  readonly lines: readonly InvoiceLineAmounts[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

/**
 * A credit note's totals (no deposit, no payment). `alreadyCreditedMinor` + this total may not
 * exceed the invoice total: that is a `MoneyError`.
 */
export function creditNoteTotals(
  lines: readonly InvoiceLineInput[],
  invoiceTotalMinor: number,
  alreadyCreditedMinor = 0,
): CreditNoteTotals {
  const totals = invoiceTotals(lines);
  if (totals.totalMinor <= 0) throw new MoneyError('a credit note must be above zero');
  if (alreadyCreditedMinor + totals.totalMinor > invoiceTotalMinor) {
    throw new MoneyError('the credit exceeds the invoice total');
  }
  return {
    lines: totals.lines,
    subtotalMinor: totals.subtotalMinor - totals.discountMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
  };
}
