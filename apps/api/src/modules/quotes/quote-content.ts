import { createHash } from 'node:crypto';
import type { QuoteLineRow, QuoteRow, QuoteStatus } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * 52-08 — the pure half of a quote: body validation, server-side totals, the canonical content
 * hash a sent quote is frozen under, and the client-safe projection its accept link shows.
 *
 * Money is integer minor units end to end. A quantity is taken with at most two decimals and kept
 * as hundredths (`quantityCenti`), so `line net = round(quantityCenti × unitPrice / 100)` and
 * `line tax = round(net × taxBp / 10 000)` are exact integer arithmetic (BigInt, half-up). A total
 * in the request body is ignored: the server always recomputes it from the lines.
 */

export const QUOTE_UNITS = ['item', 'hour', 'day', 'month', 'fixed'] as const;
export type QuoteUnit = (typeof QUOTE_UNITS)[number];

export const MAX_LINES = 100;
export const MAX_UNIT_PRICE_MINOR = 1_000_000_000;
export const MAX_QUANTITY = 10_000;
export const MAX_TAX_BP = 10_000;
export const DEFAULT_VALIDITY_DAYS = 30;
const MAX_TEXT = 5_000;
const MAX_EMAIL = 320;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
const CURRENCY_SHAPE = /^[A-Z]{3}$/u;
const LANGUAGES = ['en', 'ar'] as const;
const DAY_MS = 86_400_000;

export interface QuoteLineInput {
  readonly description: string;
  readonly unit: QuoteUnit;
  readonly quantityCenti: number;
  readonly unitPriceMinor: number;
  readonly taxBp: number;
}

export interface QuoteInput {
  readonly clientOrganizationId: string | null;
  readonly leadName: string | null;
  readonly leadEmail: string | null;
  readonly title: string;
  readonly language: string;
  readonly currency: string;
  readonly validUntil: Date;
  readonly termsText: string | null;
  readonly notesText: string | null;
  readonly lines: readonly QuoteLineInput[];
}

export interface ComputedLine extends QuoteLineInput {
  readonly position: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
}

export interface QuoteTotals {
  readonly lines: readonly ComputedLine[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

/** Half-up integer division for non-negative BigInts. */
function divRound(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor / 2n) / divisor;
}

export function computeTotals(lines: readonly QuoteLineInput[]): QuoteTotals {
  let subtotal = 0n;
  let tax = 0n;
  const computed = lines.map((line, position) => {
    const net = divRound(BigInt(line.quantityCenti) * BigInt(line.unitPriceMinor), 100n);
    const lineTax = divRound(net * BigInt(line.taxBp), 10_000n);
    subtotal += net;
    tax += lineTax;
    return { ...line, position, lineNetMinor: Number(net), lineTaxMinor: Number(lineTax) };
  });
  return {
    lines: computed,
    subtotalMinor: Number(subtotal),
    taxMinor: Number(tax),
    totalMinor: Number(subtotal + tax),
  };
}

/**
 * SHA-256 of the canonical content: everything the client is asked to accept, in a fixed order
 * (arrays, not key order). Internal notes are deliberately not part of it.
 */
export function contentHash(quote: QuoteRow, lines: readonly QuoteLineRow[]): string {
  const canonical = [
    quote.number,
    quote.title,
    quote.currency,
    quote.language,
    quote.clientOrganizationId,
    quote.leadName,
    quote.leadEmail,
    quote.validUntil.toISOString(),
    quote.termsText,
    [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => [
        l.position,
        l.description,
        l.unit,
        l.quantityCenti,
        l.unitPriceMinor,
        l.taxBp,
        l.lineNetMinor,
        l.lineTaxMinor,
      ]),
    quote.subtotalMinor,
    quote.taxMinor,
    quote.totalMinor,
  ];
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** What an outsider sees through the accept link: no ids, no notes, no internal fields. */
export function publicProjection(
  quote: QuoteRow,
  lines: readonly QuoteLineRow[],
): Readonly<Record<string, unknown>> {
  return {
    number: quote.number,
    title: quote.title,
    currency: quote.currency,
    validUntil: quote.validUntil.toISOString(),
    terms: quote.termsText,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        description: l.description,
        unit: l.unit,
        quantity: l.quantityCenti / 100,
        unitPriceMinor: l.unitPriceMinor,
        taxBp: l.taxBp,
        lineNetMinor: l.lineNetMinor,
        lineTaxMinor: l.lineTaxMinor,
      })),
    subtotalMinor: quote.subtotalMinor,
    taxMinor: quote.taxMinor,
    totalMinor: quote.totalMinor,
  };
}

/** The decision a link takes → the status it moves a sent quote to. */
export const DECISION_STATUS: Readonly<Record<string, QuoteStatus>> = {
  accept: 'accepted',
  decline: 'declined',
};

// ── validation ────────────────────────────────────────────────────────────────

export function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field, 'must be text');
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(field, `is over ${max} characters`);
  return trimmed === '' ? null : trimmed;
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, field, max);
  if (text === null) throw invalid(field, 'is required');
  return text;
}

function integerIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(field, `must be a whole number from ${min} to ${max}`);
  }
  return value as number;
}

function validateLine(raw: unknown, index: number): QuoteLineInput {
  const line = (raw ?? {}) as Record<string, unknown>;
  const at = `lines[${index}]`;
  const unit = QUOTE_UNITS.find((u) => u === (line['unit'] ?? 'item'));
  if (unit === undefined) throw invalid(`${at}.unit`, `must be one of ${QUOTE_UNITS.join(', ')}`);
  const quantity = line['quantity'];
  if (typeof quantity !== 'number' || !(quantity > 0) || quantity > MAX_QUANTITY) {
    throw invalid(`${at}.quantity`, `must be a number above 0 and at most ${MAX_QUANTITY}`);
  }
  const quantityCenti = Math.round(quantity * 100);
  if (Math.abs(quantity * 100 - quantityCenti) > 1e-6) {
    throw invalid(`${at}.quantity`, 'takes at most two decimals');
  }
  return {
    description: requiredText(line['description'], `${at}.description`, 500),
    unit,
    quantityCenti,
    unitPriceMinor: integerIn(
      line['unitPriceMinor'],
      `${at}.unitPriceMinor`,
      0,
      MAX_UNIT_PRICE_MINOR,
    ),
    taxBp: integerIn(line['taxBp'] ?? 0, `${at}.taxBp`, 0, MAX_TAX_BP),
  };
}

function validateValidUntil(value: unknown, now: Date): Date {
  if (value === undefined || value === null) {
    return endOfDay(new Date(now.getTime() + DEFAULT_VALIDITY_DAYS * DAY_MS));
  }
  if (typeof value !== 'string' || !DATE_SHAPE.test(value)) {
    throw invalid('validUntil', 'must be a date (YYYY-MM-DD)');
  }
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalid('validUntil', 'must be a real date');
  }
  if (date <= now) throw invalid('validUntil', 'must be in the future');
  return date;
}

function endOfDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T23:59:59.999Z`);
}

export function validateQuote(raw: unknown, now: Date): QuoteInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  let clientOrganizationId: string | null = null;
  if (body['clientOrganizationId'] !== undefined && body['clientOrganizationId'] !== null) {
    const id = body['clientOrganizationId'];
    if (typeof id !== 'string' || !UUID_SHAPE.test(id)) {
      throw invalid('clientOrganizationId', 'must be a UUID');
    }
    clientOrganizationId = id;
  }
  const leadName = optionalText(body['leadName'], 'leadName', 200);
  let leadEmail = optionalText(body['leadEmail'], 'leadEmail', MAX_EMAIL);
  if (leadEmail !== null) {
    if (!EMAIL_SHAPE.test(leadEmail)) throw invalid('leadEmail', 'must be an e-mail address');
    leadEmail = leadEmail.toLowerCase();
  }
  if (clientOrganizationId === null && leadName === null) {
    throw invalid('clientOrganizationId', 'name a client or a lead (leadName)');
  }
  const currency = body['currency'];
  if (typeof currency !== 'string' || !CURRENCY_SHAPE.test(currency)) {
    throw invalid('currency', 'must be an ISO 4217 code such as USD or EGP');
  }
  const language = LANGUAGES.find((l) => l === (body['language'] ?? 'en'));
  if (language === undefined) throw invalid('language', 'must be en or ar');
  const lines = body['lines'];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) {
    throw invalid('lines', `must hold 1 to ${MAX_LINES} lines`);
  }
  return {
    clientOrganizationId,
    leadName,
    leadEmail,
    title: requiredText(body['title'], 'title', 200),
    language,
    currency,
    validUntil: validateValidUntil(body['validUntil'], now),
    termsText: optionalText(body['terms'], 'terms', MAX_TEXT),
    notesText: optionalText(body['notes'], 'notes', MAX_TEXT),
    lines: lines.map(validateLine),
  };
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

export function validateEmail(value: unknown, field: string): string {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
    throw invalid(field, 'must be an e-mail address');
  }
  return email.toLowerCase();
}
