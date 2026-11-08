import { applyPayment, currencyDigits, invoiceTotals } from '@tmanage/domain';
import type { InvoiceState, InvoiceTotals } from '@tmanage/domain';
import type { ClientInvoiceDocument, InvoiceLineBody } from './InvoiceApi';

/**
 * 52-09 — the pure half of the invoice editor, send and payment forms. The totals beside the editor
 * and the state a payment would lead to come from the same `@tmanage/domain` maths the API runs, so
 * the preview never disagrees with what the server stores; the server still recomputes and
 * re-validates every amount and refuses an overpayment.
 */

export const INVOICE_LINE_UNITS = ['item', 'hour', 'day', 'month', 'fixed'] as const;
export const PAYMENT_METHODS = ['transfer', 'cash', 'cheque', 'card_offline'] as const;
export const MAX_RECIPIENTS = 10;
const MAX_QUANTITY = 100_000;
const MAX_UNIT_PRICE_MINOR = 10_000_000_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** One editable line, kept as typed text until it is saved. */
export interface InvoiceDraftLine {
  /** An existing line of the draft (keeps its time/expense source), or `null` for a new one. */
  readonly id: string | null;
  readonly sourceType: string;
  /** The description in the reader's language — the one this form edits. */
  readonly description: string;
  /** The description in the other language, kept as stored. */
  readonly otherDescription: string | null;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly taxPercent: string;
  readonly discountBp: number;
}

export type LineField = 'description' | 'quantity' | 'unitPrice' | 'taxPercent';
export interface LineProblem {
  readonly index: number;
  readonly field: LineField;
}

/** "1,250.5" → minor units in the currency's digits; `null` when not a non-negative amount. */
export function parseAmountMinor(text: string, currency: string): number | null {
  let digits: number;
  try {
    digits = currencyDigits(currency);
  } catch {
    return null;
  }
  const clean = text.replace(/[,\s]/gu, '');
  const shape = digits === 0 ? /^\d{1,13}$/u : new RegExp(`^\\d{1,13}(\\.\\d{1,${digits}})?$`, 'u');
  if (!shape.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  const minor = Number(whole + fraction.padEnd(digits, '0'));
  return Number.isSafeInteger(minor) && minor <= MAX_UNIT_PRICE_MINOR ? minor : null;
}

/** Minor units back to the plain text a field shows ("1250.50"), no grouping. */
export function minorAsText(minor: number, currency: string): string {
  let digits = 2;
  try {
    digits = currencyDigits(currency);
  } catch {
    // an unknown code keeps two decimals
  }
  if (digits === 0) return String(minor);
  const text = String(Math.abs(minor)).padStart(digits + 1, '0');
  return `${minor < 0 ? '-' : ''}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** A quantity above 0 and at most 100 000 with at most two decimals → hundredths (1.5 → 150). */
export function parseQuantityCenti(text: string): number | null {
  const clean = text.replace(/[,\s]/gu, '');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(clean)) return null;
  const value = Number(clean);
  if (!(value > 0) || value > MAX_QUANTITY) return null;
  return Math.round(value * 100);
}

/** "15" → 1500 basis points, "7.5" → 750; empty is 0; `null` outside 0–100 %. */
export function parseTaxBp(text: string): number | null {
  const clean = text.trim() === '' ? '0' : text.replace(/[%\s]/gu, '');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/u.test(clean)) return null;
  const bp = Math.round(Number(clean) * 100);
  return bp <= 10_000 ? bp : null;
}

export function emptyLine(unit: string, taxPercent: string): InvoiceDraftLine {
  return {
    id: null,
    sourceType: 'manual',
    description: '',
    otherDescription: null,
    quantity: '1',
    unit,
    unitPrice: '',
    taxPercent,
    discountBp: 0,
  };
}

/** The stored lines as editable text, the description in the reader's language. */
export function linesFromDocument(
  document: Pick<ClientInvoiceDocument, 'lines' | 'currency'>,
  arabic: boolean,
): InvoiceDraftLine[] {
  return document.lines.map((line) => {
    const mine = arabic ? line.descriptionAr : line.descriptionEn;
    const other = arabic ? line.descriptionEn : line.descriptionAr;
    return {
      id: line.id,
      sourceType: line.sourceType,
      description: mine ?? other ?? '',
      otherDescription: mine === null ? null : other,
      quantity: String(line.quantity),
      unit: line.unit,
      unitPrice: minorAsText(line.unitPriceMinor, document.currency),
      taxPercent: String(line.taxBp / 100),
      discountBp: line.discountBp,
    };
  });
}

/** The lines as the API takes them, or the first line field that is not valid. */
export function linesToBody(
  lines: readonly InvoiceDraftLine[],
  currency: string,
  arabic: boolean,
):
  | { readonly ok: true; readonly lines: InvoiceLineBody[] }
  | { readonly ok: false; readonly problem: LineProblem } {
  const out: InvoiceLineBody[] = [];
  for (const [index, line] of lines.entries()) {
    const description = line.description.trim();
    if (description === '' && (line.otherDescription ?? '').trim() === '') {
      return { ok: false, problem: { index, field: 'description' } };
    }
    const centi = parseQuantityCenti(line.quantity);
    if (centi === null) return { ok: false, problem: { index, field: 'quantity' } };
    const unitPriceMinor = parseAmountMinor(line.unitPrice, currency);
    if (unitPriceMinor === null) return { ok: false, problem: { index, field: 'unitPrice' } };
    const taxBp = parseTaxBp(line.taxPercent);
    if (taxBp === null) return { ok: false, problem: { index, field: 'taxPercent' } };
    const mine = description === '' ? null : description;
    out.push({
      id: line.id,
      descriptionEn: arabic ? line.otherDescription : mine,
      descriptionAr: arabic ? mine : line.otherDescription,
      quantity: centi / 100,
      unit: line.unit,
      unitPriceMinor,
      discountBp: line.discountBp,
      taxBp,
    });
  }
  return { ok: true, lines: out };
}

/** The live totals beside the editor; lines still being typed count as zero. */
export function previewInvoiceTotals(
  lines: readonly InvoiceDraftLine[],
  currency: string,
): InvoiceTotals {
  return invoiceTotals(
    lines.map((line) => ({
      quantityCenti: parseQuantityCenti(line.quantity) ?? 0,
      unitPriceMinor: parseAmountMinor(line.unitPrice, currency) ?? 0,
      discountBp: line.discountBp,
      taxBp: parseTaxBp(line.taxPercent) ?? 0,
    })),
  );
}

export type PaymentPreview =
  | { readonly ok: true; readonly state: InvoiceState; readonly remainingMinor: number }
  | {
      readonly ok: false;
      readonly error: 'invalid_state' | 'invalid_amount' | 'overpayment';
    };

/**
 * What recording `amountText` would do: sent → partially_paid → paid once paid plus the applied
 * deposit reaches the total. Above the amount due is an overpayment (the API refuses it unless the
 * organization allows one, so the form refuses it first).
 */
export function previewPayment(
  invoice: Pick<
    ClientInvoiceDocument,
    'state' | 'totalMinor' | 'paidMinor' | 'depositAppliedMinor' | 'currency'
  >,
  amountText: string,
): PaymentPreview {
  const amountMinor = parseAmountMinor(amountText, invoice.currency);
  const outcome = applyPayment(
    {
      state: invoice.state as InvoiceState,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      depositAppliedMinor: invoice.depositAppliedMinor,
    },
    amountMinor ?? 0,
    false,
  );
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    state: outcome.state,
    remainingMinor: Math.max(
      0,
      invoice.totalMinor - outcome.paidMinor - invoice.depositAppliedMinor,
    ),
  };
}

/** "a@x.sa, b@y.sa" → the unique addresses; `null` when one is not an address or there are none. */
export function parseRecipients(text: string): string[] | null {
  const parts = text
    .split(/[,;\s]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  const unique = [...new Set(parts)];
  if (unique.length === 0 || unique.length > MAX_RECIPIENTS) return null;
  return unique.every((email) => email.length <= 254 && EMAIL.test(email)) ? unique : null;
}

/** Only a draft is edited and sent; a sent or part-paid invoice takes payments. */
export function invoiceMayTakePayment(state: string): boolean {
  return state === 'sent' || state === 'partially_paid';
}
