import type { CapsuleState } from '@tmanage/ui';
import type { QuoteDocument, QuoteInput, QuoteStatus } from './QuoteApi';

/** The status filters of the list, in the order of the R31 L04 Figma frame. */
export const QUOTE_FILTERS = ['all', 'draft', 'sent', 'accepted', 'declined'] as const;
export type QuoteFilter = (typeof QUOTE_FILTERS)[number];

/** The units a line takes; the API refuses any other. */
export const QUOTE_UNITS = ['item', 'hour', 'day', 'month', 'fixed'] as const;

/** Accepted is done; sent waits on the client; declined is blocked; expired archived; draft neutral. */
export function quoteCapsule(status: QuoteStatus): CapsuleState {
  if (status === 'accepted') return 'done';
  if (status === 'sent') return 'waiting';
  if (status === 'declined') return 'blocked';
  if (status === 'expired') return 'archived';
  return 'neutral';
}

/** One editable line, kept as the text the person typed until it is saved. */
export interface DraftLine {
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxPercent: string;
}

export interface QuoteDraft {
  readonly title: string;
  readonly clientOrganizationId: string;
  readonly leadName: string;
  readonly leadEmail: string;
  readonly currency: string;
  readonly language: string;
  readonly validUntil: string;
  readonly terms: string;
  readonly notes: string;
  readonly lines: readonly DraftLine[];
}

export const EMPTY_LINE: DraftLine = {
  description: '',
  unit: 'item',
  quantity: '1',
  unitPrice: '',
  taxPercent: '0',
};

const DECIMAL = /^\d+(?:\.\d{1,2})?$/u;

/** "1,250.5" → 125050 minor units; null when it is not a non-negative amount with ≤ 2 decimals. */
export function parseMinor(text: string): number | null {
  const clean = text.replace(/[,\s]/gu, '');
  if (!DECIMAL.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** "14" → 1400 basis points, "7.5" → 750; null outside 0–100 %. */
export function parseTaxBp(text: string): number | null {
  const bp = parseMinor(text.trim() === '' ? '0' : text);
  return bp === null || bp > 10_000 ? null : bp;
}

/** A quantity above 0 and at most 10 000, with at most two decimals. */
export function parseQuantity(text: string): number | null {
  const clean = text.replace(/[,\s]/gu, '');
  if (!DECIMAL.test(clean)) return null;
  const value = Number(clean);
  return value > 0 && value <= 10_000 ? value : null;
}

function divRound(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor / 2n) / divisor;
}

/** The same half-up integer arithmetic the server uses, for the live totals beside the editor. */
export function previewTotals(lines: readonly DraftLine[]): {
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
} {
  let subtotal = 0n;
  let tax = 0n;
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    const price = parseMinor(line.unitPrice);
    const bp = parseTaxBp(line.taxPercent);
    if (quantity === null || price === null || bp === null) continue;
    const net = divRound(BigInt(Math.round(quantity * 100)) * BigInt(price), 100n);
    subtotal += net;
    tax += divRound(net * BigInt(bp), 10_000n);
  }
  return {
    subtotalMinor: Number(subtotal),
    taxMinor: Number(tax),
    totalMinor: Number(subtotal + tax),
  };
}

export type DraftProblem =
  | 'title'
  | 'client'
  | 'currency'
  | 'validUntil'
  | 'lines'
  | {
      readonly line: number;
      readonly field: 'description' | 'quantity' | 'unitPrice' | 'taxPercent';
    };

/** The request body, or the first problem the person must fix before it can be saved. */
export function draftToInput(
  draft: QuoteDraft,
  version: number | null,
):
  | { readonly ok: true; readonly input: QuoteInput }
  | { readonly ok: false; readonly problem: DraftProblem } {
  if (draft.title.trim() === '') return { ok: false, problem: 'title' };
  if (draft.clientOrganizationId === '' && draft.leadName.trim() === '') {
    return { ok: false, problem: 'client' };
  }
  if (!/^[A-Z]{3}$/u.test(draft.currency.trim().toUpperCase())) {
    return { ok: false, problem: 'currency' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft.validUntil)) return { ok: false, problem: 'validUntil' };
  if (draft.lines.length === 0 || draft.lines.length > 100) return { ok: false, problem: 'lines' };
  const lines: QuoteInput['lines'][number][] = [];
  for (const [index, line] of draft.lines.entries()) {
    if (line.description.trim() === '') {
      return { ok: false, problem: { line: index, field: 'description' } };
    }
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) return { ok: false, problem: { line: index, field: 'quantity' } };
    const unitPriceMinor = parseMinor(line.unitPrice);
    if (unitPriceMinor === null) return { ok: false, problem: { line: index, field: 'unitPrice' } };
    const taxBp = parseTaxBp(line.taxPercent);
    if (taxBp === null) return { ok: false, problem: { line: index, field: 'taxPercent' } };
    lines.push({
      description: line.description.trim(),
      unit: line.unit,
      quantity,
      unitPriceMinor,
      taxBp,
    });
  }
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    ok: true,
    input: {
      clientOrganizationId: draft.clientOrganizationId === '' ? null : draft.clientOrganizationId,
      leadName: text(draft.leadName),
      leadEmail: text(draft.leadEmail),
      title: draft.title.trim(),
      language: draft.language,
      currency: draft.currency.trim().toUpperCase(),
      validUntil: draft.validUntil,
      terms: text(draft.terms),
      notes: text(draft.notes),
      lines,
      ...(version === null ? {} : { version }),
    },
  };
}

function minorText(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** A saved quote back into editable text. */
export function documentToDraft(quote: QuoteDocument): QuoteDraft {
  return {
    title: quote.title,
    clientOrganizationId: quote.clientOrganizationId ?? '',
    leadName: quote.leadName ?? '',
    leadEmail: quote.leadEmail ?? '',
    currency: quote.currency,
    language: quote.language,
    validUntil: quote.validUntil.slice(0, 10),
    terms: quote.terms ?? '',
    notes: quote.notes ?? '',
    lines: quote.lines.map((line) => ({
      description: line.description,
      unit: line.unit,
      quantity: String(line.quantity),
      unitPrice: minorText(line.unitPriceMinor),
      taxPercent: String(line.taxBp / 100),
    })),
  };
}

/** A new draft: one empty line, valid for 30 days from `today` (`YYYY-MM-DD`). */
export function newDraft(today: Date): QuoteDraft {
  const valid = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    title: '',
    clientOrganizationId: '',
    leadName: '',
    leadEmail: '',
    currency: 'USD',
    language: 'en',
    validUntil: valid,
    terms: '',
    notes: '',
    lines: [EMPTY_LINE],
  };
}

/** The page a client opens to accept or decline: `/q/<token>` on this web origin. */
export function quoteLinkUrl(origin: string, token: string): string {
  return `${origin}/q/${encodeURIComponent(token)}`;
}
