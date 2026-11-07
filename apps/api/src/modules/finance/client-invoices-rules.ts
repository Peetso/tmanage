import { createHash } from 'node:crypto';
import {
  INVOICE_KINDS,
  INVOICE_LANGUAGES,
  PAYMENT_METHODS,
  isCurrencyCode,
  isDocumentLabel,
} from '@tmanage/domain';
import type { DocumentLabel, InvoiceKind, InvoiceLanguage, PaymentMethod } from '@tmanage/domain';
import type { ClientInvoiceLineRow, ClientInvoiceRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * 52-09 — the pure half of a client invoice: body validation, the canonical content hash a sent
 * invoice is frozen under, date helpers and the org-setting keys. Money is integer minor units; a
 * quantity is taken with at most two decimals and kept as hundredths (`quantityCenti`). A total in
 * a body is never read: the server recomputes every amount from the lines (`invoiceTotals`).
 */

export const MAX_INVOICE_LINES = 200;
export const MAX_DESCRIPTION = 500;
export const MAX_PO = 64;
export const MAX_TEXT = 5_000;
export const MAX_MESSAGE = 2_000;
export const MAX_RECIPIENTS = 10;
export const MAX_UNIT_PRICE_MINOR = 10_000_000_000;
export const MAX_QUANTITY = 100_000;
export const LIST_PAGE = 50;
export const LINE_UNITS = ['item', 'hour', 'day', 'month', 'fixed'] as const;
export type LineUnit = (typeof LINE_UNITS)[number];

/** C5: the unit as the print shows it, per invoice language; an unknown unit stays as stored. */
const UNIT_LABELS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  item: { en: 'item', ar: 'بند' },
  hour: { en: 'hour', ar: 'ساعة' },
  day: { en: 'day', ar: 'يوم' },
  month: { en: 'month', ar: 'شهر' },
  fixed: { en: 'fixed', ar: 'مبلغ ثابت' },
};

export function unitLabel(unit: string, lang: 'en' | 'ar' | 'bi'): string {
  const copy = UNIT_LABELS[unit];
  if (copy === undefined) return unit;
  return lang === 'bi' ? `${copy.en} / ${copy.ar}` : copy[lang];
}

/** C5: the Arabic name of an expense category (`EXPENSE_CATEGORIES`); unknown stays as stored. */
const EXPENSE_CATEGORY_AR: Readonly<Record<string, string>> = {
  Ads: 'إعلانات',
  Software: 'برمجيات',
  Travel: 'سفر',
  Print: 'طباعة',
  Freelancer: 'عمل حر',
  Other: 'أخرى',
};

export function expenseCategoryAr(category: string): string {
  return EXPENSE_CATEGORY_AR[category] ?? category;
}

/**
 * C5: lines pulled before this fix stored `مصروف — Software (…)`; the print and portal show the
 * category in Arabic without rewriting the issued line.
 */
export function arabicExpenseDescription(text: string): string {
  return text.replace(
    /^(مصروف — )([A-Za-z]+)( \()/u,
    (_m, head: string, category: string, tail: string) =>
      `${head}${expenseCategoryAr(category)}${tail}`,
  );
}
export const TIME_GROUPINGS = ['by_task', 'by_person', 'by_day', 'single'] as const;
export type TimeGrouping = (typeof TIME_GROUPINGS)[number];
export const SOURCE_TYPES = ['time', 'expense', 'retainer', 'quote', 'manual'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Org settings (`org_settings`, read like `expense.auto_approve_under_minor`). */
export const STEP_UP_SEND_SETTING_KEY = 'finance.step_up_send_minor';
export const DEFAULT_STEP_UP_SEND_MINOR = 5_000_000;
export const ALLOW_OVERPAYMENT_SETTING_KEY = 'finance.allow_overpayment';
export const PORTAL_SHOW_NAMES_SETTING_KEY = 'finance.portal_show_names';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_EMAIL = 254;
const MAX_PERIOD_DAYS = 400;
const DAY_MS = 86_400_000;

export function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

// ── primitives ───────────────────────────────────────────────────────────────

function record(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

function uuidOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw invalid(field, 'must be a UUID');
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field, 'must be text');
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(field, `is over ${String(max)} characters`);
  return trimmed === '' ? null : trimmed;
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, field, max);
  if (text === null) throw invalid(field, 'is required');
  return text;
}

function integerIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(field, `must be a whole number from ${String(min)} to ${String(max)}`);
  }
  return value as number;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_SHAPE.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isIsoDate(value)) throw invalid(field, 'must be a date (YYYY-MM-DD)');
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  list: readonly T[],
  field: string,
  fallback?: T,
): T {
  const found = list.find((item) => item === (value ?? fallback));
  if (found === undefined) throw invalid(field, `must be one of ${list.join(', ')}`);
  return found;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `quantity` (≤ 2 decimals) → hundredths. */
export function quantityCentiOf(value: unknown, field: string): number {
  if (typeof value !== 'number' || !(value > 0) || value > MAX_QUANTITY) {
    throw invalid(field, `must be a number above 0 and at most ${String(MAX_QUANTITY)}`);
  }
  const centi = Math.round(value * 100);
  if (Math.abs(value * 100 - centi) > 1e-6) throw invalid(field, 'takes at most two decimals');
  return centi;
}

// ── bodies ───────────────────────────────────────────────────────────────────

export interface InvoiceCreateInput {
  readonly clientOrganizationId: string;
  readonly projectId: string | null;
  readonly kind: InvoiceKind;
  readonly language: InvoiceLanguage;
  readonly currency: string | null;
  readonly issueDate: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly poNumber: string | null;
  readonly notesText: string | null;
  readonly internalNote: string | null;
  readonly termsText: string | null;
}

export function validateCreate(raw: unknown): InvoiceCreateInput {
  const body = record(raw);
  const clientOrganizationId = body['clientOrganizationId'];
  if (!isUuid(clientOrganizationId)) throw invalid('clientOrganizationId', 'must be a UUID');
  let currency: string | null = null;
  if (body['currency'] !== undefined && body['currency'] !== null) {
    if (!isCurrencyCode(body['currency'])) {
      throw invalid('currency', 'must be a supported ISO 4217 code such as SAR or USD');
    }
    currency = body['currency'];
  }
  const periodStart = dateOrNull(body['periodStart'], 'periodStart');
  const periodEnd = dateOrNull(body['periodEnd'], 'periodEnd');
  checkPeriod(periodStart, periodEnd);
  return {
    clientOrganizationId,
    projectId: uuidOrNull(body['projectId'], 'projectId'),
    kind: oneOf(body['kind'], INVOICE_KINDS, 'kind', 'standard'),
    language: oneOf(body['language'], INVOICE_LANGUAGES, 'language', 'bi'),
    currency,
    issueDate: dateOrNull(body['issueDate'], 'issueDate'),
    periodStart,
    periodEnd,
    poNumber: optionalText(body['poNumber'], 'poNumber', MAX_PO),
    notesText: optionalText(body['notes'], 'notes', MAX_TEXT),
    internalNote: optionalText(body['internalNote'], 'internalNote', MAX_TEXT),
    termsText: optionalText(body['terms'], 'terms', MAX_TEXT),
  };
}

function checkPeriod(from: string | null, to: string | null): void {
  if ((from === null) !== (to === null)) throw invalid('periodEnd', 'give both ends of the period');
  if (from !== null && to !== null) {
    if (to < from) throw invalid('periodEnd', 'must not be before periodStart');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS > MAX_PERIOD_DAYS) {
      throw invalid('periodEnd', `a period spans at most ${String(MAX_PERIOD_DAYS)} days`);
    }
  }
}

export interface LineInput {
  /** An existing line of this draft (keeps its source), or `null` for a manual line. */
  readonly id: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly quantityCenti: number;
  readonly unit: LineUnit;
  readonly unitPriceMinor: number;
  readonly discountBp: number;
  readonly taxBp: number;
}

function validateLine(raw: unknown, index: number): LineInput {
  const line = record(raw);
  const at = `lines[${String(index)}]`;
  const descriptionEn = optionalText(line['descriptionEn'], `${at}.descriptionEn`, MAX_DESCRIPTION);
  const descriptionAr = optionalText(line['descriptionAr'], `${at}.descriptionAr`, MAX_DESCRIPTION);
  if (descriptionEn === null && descriptionAr === null) {
    throw invalid(`${at}.descriptionEn`, 'give a description in English or Arabic');
  }
  return {
    id: uuidOrNull(line['id'], `${at}.id`),
    descriptionEn,
    descriptionAr,
    quantityCenti: quantityCentiOf(line['quantity'], `${at}.quantity`),
    unit: oneOf(line['unit'], LINE_UNITS, `${at}.unit`, 'item'),
    unitPriceMinor: integerIn(
      line['unitPriceMinor'],
      `${at}.unitPriceMinor`,
      0,
      MAX_UNIT_PRICE_MINOR,
    ),
    discountBp: integerIn(line['discountBp'] ?? 0, `${at}.discountBp`, 0, 10_000),
    taxBp: integerIn(line['taxBp'] ?? 0, `${at}.taxBp`, 0, 10_000),
  };
}

export interface InvoicePatch {
  readonly expectedVersion: number;
  readonly kind?: InvoiceKind;
  readonly language?: InvoiceLanguage;
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly supplyDate?: string | null;
  readonly poNumber?: string | null;
  readonly notesText?: string | null;
  readonly internalNote?: string | null;
  readonly termsText?: string | null;
  readonly depositAppliedMinor?: number;
  readonly lines?: readonly LineInput[];
}

export function validatePatch(raw: unknown): InvoicePatch {
  const body = record(raw);
  const patch: Record<string, unknown> = {
    expectedVersion: integerIn(
      body['expectedVersion'],
      'expectedVersion',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (body['kind'] !== undefined) patch['kind'] = oneOf(body['kind'], INVOICE_KINDS, 'kind');
  if (body['language'] !== undefined) {
    patch['language'] = oneOf(body['language'], INVOICE_LANGUAGES, 'language');
  }
  for (const key of ['issueDate', 'dueDate'] as const) {
    if (body[key] !== undefined) {
      if (!isIsoDate(body[key])) throw invalid(key, 'must be a date (YYYY-MM-DD)');
      patch[key] = body[key];
    }
  }
  if (body['supplyDate'] !== undefined)
    patch['supplyDate'] = dateOrNull(body['supplyDate'], 'supplyDate');
  if (body['poNumber'] !== undefined)
    patch['poNumber'] = optionalText(body['poNumber'], 'poNumber', MAX_PO);
  if (body['notes'] !== undefined)
    patch['notesText'] = optionalText(body['notes'], 'notes', MAX_TEXT);
  if (body['internalNote'] !== undefined) {
    patch['internalNote'] = optionalText(body['internalNote'], 'internalNote', MAX_TEXT);
  }
  if (body['terms'] !== undefined)
    patch['termsText'] = optionalText(body['terms'], 'terms', MAX_TEXT);
  if (body['depositAppliedMinor'] !== undefined) {
    patch['depositAppliedMinor'] = integerIn(
      body['depositAppliedMinor'],
      'depositAppliedMinor',
      0,
      MAX_UNIT_PRICE_MINOR,
    );
  }
  if (body['lines'] !== undefined) {
    const lines = body['lines'];
    if (!Array.isArray(lines) || lines.length > MAX_INVOICE_LINES) {
      throw invalid('lines', `must hold at most ${String(MAX_INVOICE_LINES)} lines`);
    }
    const parsed = lines.map(validateLine);
    const ids = parsed.flatMap((l) => (l.id === null ? [] : [l.id]));
    if (new Set(ids).size !== ids.length) throw invalid('lines', 'a line id appears twice');
    patch['lines'] = parsed;
  }
  return patch as unknown as InvoicePatch;
}

export interface PullInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly time: TimeGrouping | null;
  readonly expenses: boolean;
  readonly retainer: boolean;
  readonly quote: { readonly quoteId: string; readonly depositBp: number | null } | null;
}

export function validatePull(raw: unknown): PullInput {
  const body = record(raw);
  const period = record(body['period']);
  const periodStart = period['from'];
  const periodEnd = period['to'];
  if (!isIsoDate(periodStart)) throw invalid('period.from', 'must be a date (YYYY-MM-DD)');
  if (!isIsoDate(periodEnd)) throw invalid('period.to', 'must be a date (YYYY-MM-DD)');
  checkPeriod(periodStart, periodEnd);
  const include = record(body['include']);
  const time =
    include['time'] === undefined || include['time'] === false || include['time'] === null
      ? null
      : oneOf(
          include['time'] === true ? 'by_task' : include['time'],
          TIME_GROUPINGS,
          'include.time',
        );
  let quote: PullInput['quote'] = null;
  if (include['quote'] !== undefined && include['quote'] !== null && include['quote'] !== false) {
    const q = record(include['quote']);
    if (!isUuid(q['quoteId'])) throw invalid('include.quote.quoteId', 'must be a UUID');
    quote = {
      quoteId: q['quoteId'],
      depositBp:
        q['depositPercent'] === undefined || q['depositPercent'] === null
          ? null
          : integerIn(q['depositPercent'], 'include.quote.depositPercent', 1, 100) * 100,
    };
  }
  return {
    periodStart,
    periodEnd,
    time,
    expenses: include['expenses'] === true,
    retainer: include['retainer'] === true,
    quote,
  };
}

/**
 * B2: the line kinds a pull replaces — only the ones it asks for. Pulling time alone keeps the
 * expense, retainer and quote lines already on the draft; manual lines are never replaced.
 */
export function pulledSourceTypes(input: PullInput): ReadonlySet<string> {
  const kinds = new Set<string>();
  if (input.time !== null) kinds.add('time');
  if (input.expenses) kinds.add('expense');
  if (input.retainer) kinds.add('retainer');
  if (input.quote !== null) kinds.add('quote');
  return kinds;
}

export function validateEmail(value: unknown, field: string): string {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
    throw invalid(field, 'must be an e-mail address');
  }
  return email.toLowerCase();
}

export interface SendInput {
  readonly to: readonly string[];
  readonly message: string | null;
  readonly attachPdf: boolean;
}

export function validateSend(raw: unknown): SendInput {
  const body = record(raw);
  const to = body['to'];
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS) {
    throw invalid('to', `name 1 to ${String(MAX_RECIPIENTS)} recipients`);
  }
  const recipients = [...new Set(to.map((value, i) => validateEmail(value, `to[${String(i)}]`)))];
  return {
    to: recipients,
    message: optionalText(body['message'], 'message', MAX_MESSAGE),
    // 52-10 is not built: accepted and ignored (the mail carries the portal link only).
    attachPdf: body['attachPdf'] === true,
  };
}

export interface PaymentInput {
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly method: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
}

export function validatePayment(raw: unknown): PaymentInput {
  const body = record(raw);
  if (!isIsoDate(body['paidOn'])) throw invalid('paidOn', 'must be a date (YYYY-MM-DD)');
  return {
    paidOn: body['paidOn'],
    amountMinor: integerIn(body['amountMinor'], 'amountMinor', 1, MAX_UNIT_PRICE_MINOR),
    method: oneOf(body['method'], PAYMENT_METHODS, 'method', 'transfer'),
    reference: optionalText(body['reference'], 'reference', 120),
    note: optionalText(body['note'], 'note', MAX_DESCRIPTION),
  };
}

/** 52-28 — `PATCH …/label {documentLabel}`. */
export function validateLabel(raw: unknown): DocumentLabel {
  const label = record(raw)['documentLabel'];
  if (!isDocumentLabel(label)) {
    throw invalid('documentLabel', 'must be one of invoice, proforma, commercial, tax_invoice');
  }
  return label;
}

export interface TaxRegistrationInput {
  readonly ref: string;
  /** Midnight UTC of the registration day, or the exact instant when one was given. */
  readonly registeredAt: Date;
}

/** 52-28 — `POST …/tax-registration {ref, registeredAt}`; the shape per regime is checked later. */
export function validateTaxRegistration(raw: unknown, now: Date): TaxRegistrationInput {
  const body = record(raw);
  const ref = requiredText(body['ref'], 'ref', 64);
  const at = body['registeredAt'];
  let registeredAt: Date;
  if (isIsoDate(at)) registeredAt = new Date(`${at}T00:00:00.000Z`);
  else if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/u.test(at)) {
    registeredAt = new Date(at);
    if (Number.isNaN(registeredAt.getTime())) throw invalid('registeredAt', 'is not a date');
  } else throw invalid('registeredAt', 'must be a date (YYYY-MM-DD) or an ISO date-time');
  if (registeredAt.getTime() > now.getTime() + DAY_MS) {
    throw invalid('registeredAt', 'must not be in the future');
  }
  return { ref, registeredAt };
}

export function validateReason(raw: unknown): string {
  return requiredText(record(raw)['reason'], 'reason', MAX_DESCRIPTION);
}

export interface CreditNoteInput {
  readonly reason: string;
  /** `null` = credit the whole invoice (its lines, as issued). */
  readonly lines: readonly LineInput[] | null;
}

export function validateCreditNote(raw: unknown): CreditNoteInput {
  const body = record(raw);
  const reason = requiredText(body['reason'], 'reason', MAX_DESCRIPTION);
  if (body['full'] === true) return { reason, lines: null };
  const lines = body['lines'];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_INVOICE_LINES) {
    throw invalid('lines', `give full: true or 1 to ${String(MAX_INVOICE_LINES)} lines`);
  }
  return { reason, lines: lines.map(validateLine) };
}

export interface ListQuery {
  readonly state: string | null;
  readonly clientOrganizationId: string | null;
  readonly cursor: string | null;
}

export function validateListQuery(query: Record<string, unknown>): ListQuery {
  const state = query['state'];
  if (state !== undefined && (typeof state !== 'string' || !/^[a-z_]{1,16}$/u.test(state))) {
    throw invalid('state', 'is not a known state');
  }
  return {
    state: typeof state === 'string' ? state : null,
    clientOrganizationId: uuidOrNull(query['clientOrganizationId'], 'clientOrganizationId'),
    cursor: uuidOrNull(query['cursor'], 'cursor'),
  };
}

// ── the frozen content ───────────────────────────────────────────────────────

/**
 * SHA-256 of the canonical content: everything the client is billed for, in a fixed order
 * (arrays, not key order). The internal note is deliberately not part of it.
 */
export function invoiceContentHash(
  invoice: Pick<
    ClientInvoiceRow,
    | 'number'
    | 'kind'
    | 'language'
    | 'clientOrganizationId'
    | 'issueDate'
    | 'dueDate'
    | 'supplyDate'
    | 'currency'
    | 'fxRate'
    | 'subtotalMinor'
    | 'discountMinor'
    | 'taxMinor'
    | 'totalMinor'
    | 'depositAppliedMinor'
    | 'poNumber'
    | 'notesText'
    | 'termsText'
    | 'buyerSnapshotJson'
    | 'sellerSnapshotJson'
  >,
  lines: readonly ClientInvoiceLineRow[],
): string {
  const canonical = [
    invoice.number,
    invoice.kind,
    invoice.language,
    invoice.clientOrganizationId,
    invoice.issueDate,
    invoice.dueDate,
    invoice.supplyDate,
    invoice.currency,
    invoice.fxRate,
    invoice.buyerSnapshotJson,
    invoice.sellerSnapshotJson,
    invoice.poNumber,
    invoice.notesText,
    invoice.termsText,
    [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => [
        l.position,
        l.descriptionEn,
        l.descriptionAr,
        l.quantityCenti,
        l.unit,
        l.unitPriceMinor,
        l.discountBp,
        l.taxBp,
        l.lineDiscountMinor,
        l.lineNetMinor,
        l.lineTaxMinor,
        l.lineGrossMinor,
      ]),
    Number(invoice.subtotalMinor),
    Number(invoice.discountMinor),
    Number(invoice.taxMinor),
    Number(invoice.totalMinor),
    Number(invoice.depositAppliedMinor),
  ];
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** SHA-256 of an `Idempotency-Key` (≤ 128 printable characters), or `null` when none was sent. */
export function idempotencyKeyHash(header: unknown): string | null {
  if (header === undefined || header === null || header === '') return null;
  if (typeof header !== 'string' || header.length > 128 || !/^[\x21-\x7e]+$/u.test(header)) {
    throw invalid('Idempotency-Key', 'must be 1 to 128 printable characters');
  }
  return createHash('sha256').update(header, 'utf8').digest('hex');
}

/** The lines a source id list is stored as on a pulled line. */
export function sourceIdsOf(json: string | null): readonly string[] {
  if (json === null || json === '') return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isUuid) : [];
  } catch {
    return [];
  }
}
