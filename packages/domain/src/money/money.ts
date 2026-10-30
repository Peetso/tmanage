/**
 * 52-23 — the shared money type (spec 52 §4 "Money type").
 *
 * - An amount is an **integer in minor units** of its currency (halalas, fils, piastres, cents).
 *   No floating-point arithmetic touches an amount; intermediate products run in `bigint`.
 * - Tax is computed **per line, rounded half-up at the line, then summed** (line-level rounding to
 *   the currency's minor unit; ZATCA and the UAE FTA both accept it). Half-up here means half away
 *   from zero, so a credit line rounds as the mirror of its debit.
 * - The browser never recomputes a figure: the API returns every computed amount.
 * - `formatMoney` is for display only; `digits: 'arab'` renders Eastern Arabic digits.
 */

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Minor-unit digits per ISO 4217 code we accept. Everything not listed here is refused. */
export const CURRENCY_DIGITS: Readonly<Record<string, number>> = {
  SAR: 2,
  AED: 2,
  EGP: 2,
  QAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  MAD: 2,
  TRY: 2,
  INR: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  IQD: 3,
  JPY: 0,
};

export type MoneyDigits = 'latn' | 'arab';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(CURRENCY_DIGITS, code);
}

export function currencyDigits(currency: string): number {
  const digits = CURRENCY_DIGITS[currency];
  if (digits === undefined) throw new MoneyError(`unknown currency ${currency}`);
  return digits;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError('amount out of range');
  }
  return Number(value);
}

function toBig(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be a whole number`);
  return BigInt(value);
}

/** `numerator / denominator` rounded half away from zero; `denominator` > 0. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('denominator must be positive');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -quotient : quotient;
}

export function money(amountMinor: number, currency: string): Money {
  currencyDigits(currency);
  toBig(amountMinor, 'amountMinor');
  return { amountMinor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new MoneyError('currencies differ');
  return money(toSafeNumber(BigInt(a.amountMinor) + BigInt(b.amountMinor)), a.currency);
}

/**
 * A decimal string (`"10.005"`, `"-3"`) to minor units, half-up at the currency's minor unit.
 * `"0.005"` USD is 1 cent; `"0.0049"` is 0.
 */
export function parseMoney(text: string, currency: string): Money {
  const digits = currencyDigits(currency);
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,12}))?$/u.exec(text.trim());
  if (match === null) throw new MoneyError('not a decimal amount');
  const [, sign = '', whole = '0', fraction = ''] = match;
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole) * scale + BigInt(fraction === '' ? '0' : fraction);
  const minor = divideHalfUp(scaled * 10n ** BigInt(digits), scale);
  return money(toSafeNumber(sign === '-' ? -minor : minor), currency);
}

export interface LineAmounts {
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  readonly lineGrossMinor: number;
}

/** Tax in basis points (1500 = 15 %) on one line's net, rounded half-up at the line. */
export function computeLineTax(lineNetMinor: number, taxBp: number): LineAmounts {
  if (!Number.isInteger(taxBp) || taxBp < 0 || taxBp > 10_000) {
    throw new MoneyError('taxBp must be a whole number from 0 to 10000');
  }
  const net = toBig(lineNetMinor, 'lineNetMinor');
  const tax = divideHalfUp(net * BigInt(taxBp), 10_000n);
  return {
    lineNetMinor,
    lineTaxMinor: toSafeNumber(tax),
    lineGrossMinor: toSafeNumber(net + tax),
  };
}

/** Quantity in hundredths (150 = 1.5) × unit price, rounded half-up to the minor unit. */
export function lineNetFromQuantity(quantityCenti: number, unitPriceMinor: number): number {
  const product = toBig(quantityCenti, 'quantityCenti') * toBig(unitPriceMinor, 'unitPriceMinor');
  return toSafeNumber(divideHalfUp(product, 100n));
}

export interface DocumentTotals {
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

/** Totals are the sums of the already-rounded lines; never re-rounded. */
export function sumLines(lines: readonly LineAmounts[]): DocumentTotals {
  let net = 0n;
  let tax = 0n;
  for (const line of lines) {
    net += BigInt(line.lineNetMinor);
    tax += BigInt(line.lineTaxMinor);
  }
  return {
    netMinor: toSafeNumber(net),
    taxMinor: toSafeNumber(tax),
    grossMinor: toSafeNumber(net + tax),
  };
}

/**
 * Display only. `locale` is a BCP-47 tag (`ar-SA`, `en`); `digits: 'arab'` forces Eastern Arabic
 * digits (`-u-nu-arab`), `'latn'` forces Western digits even in an Arabic locale.
 */
export function formatMoney(value: Money, locale: string, digits: MoneyDigits = 'latn'): string {
  const fractionDigits = currencyDigits(value.currency);
  const base = locale.split('-u-')[0] ?? 'en';
  const tag = `${base}-u-nu-${digits}`;
  return new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value.amountMinor / 10 ** fractionDigits);
}
