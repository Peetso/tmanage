import {
  ADDRESS_FIELDS,
  addressFormatErrors,
  addressMissing,
  EINVOICE_REGIMES,
  parseAddressJson,
  resolvedRegime,
  taxNoticeCopy,
  VAT_REGISTRATION_STATUSES,
} from '@tmanage/domain';
import type { EinvoiceRegime, StructuredAddress, VatRegistrationStatus } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';

/**
 * 52-23 — the pure half of the finance module: closed lists, body validation, defaults for an
 * organization that has not saved a profile yet, the seeded tax rates, the readiness check and
 * the TRN mask used in the audit trail. No I/O here.
 */

export const NUMBERING_RESETS = ['yearly', 'never'] as const;
export type NumberingReset = (typeof NUMBERING_RESETS)[number];
export const DIGIT_SYSTEMS = ['latn', 'arab'] as const;
export const ZATCA_CATEGORIES = ['S', 'Z', 'E', 'O'] as const;
export type ZatcaCategory = (typeof ZATCA_CATEGORIES)[number];

/** Accepted ISO 4217 codes; mirrors `CURRENCY_DIGITS` in `@tmanage/domain` money. */
export const FINANCE_CURRENCIES = [
  'SAR',
  'AED',
  'EGP',
  'QAR',
  'USD',
  'EUR',
  'GBP',
  'MAD',
  'TRY',
  'INR',
  'CAD',
  'AUD',
  'CHF',
  'KWD',
  'BHD',
  'OMR',
  'JOD',
  'TND',
  'IQD',
  'JPY',
] as const;

const COUNTRY_DEFAULTS: Readonly<Record<string, { currency: string; taxBp: number }>> = {
  SA: { currency: 'SAR', taxBp: 1500 },
  AE: { currency: 'AED', taxBp: 500 },
  EG: { currency: 'EGP', taxBp: 1400 },
  BH: { currency: 'BHD', taxBp: 1000 },
  OM: { currency: 'OMR', taxBp: 500 },
  KW: { currency: 'KWD', taxBp: 0 },
  QA: { currency: 'QAR', taxBp: 0 },
  JO: { currency: 'JOD', taxBp: 1600 },
  US: { currency: 'USD', taxBp: 0 },
  GB: { currency: 'GBP', taxBp: 2000 },
};
const FALLBACK_COUNTRY = 'SA';

export interface FinanceProfileValues {
  readonly country: string;
  readonly baseCurrency: string;
  readonly taxRegistrationNo: string | null;
  readonly taxScheme: string;
  readonly defaultTaxRateBp: number;
  readonly legalNameEn: string | null;
  readonly legalNameAr: string | null;
  readonly addressEn: string | null;
  readonly addressAr: string | null;
  readonly invoicePrefix: string;
  readonly quotePrefix: string;
  readonly creditNotePrefix: string;
  readonly numberingReset: NumberingReset;
  readonly roundingMinutes: number;
  readonly weekStart: number;
  readonly digits: (typeof DIGIT_SYSTEMS)[number];
  readonly showHijri: boolean;
  readonly bankDetailsText: string | null;
  readonly paymentTermsDays: number;
  /** 52-28: VAT registration; a registered KSA/EG org drafts proforma invoices by default. */
  readonly vatRegistrationStatus: VatRegistrationStatus;
  /** 52-28: the e-invoice regime override; `null` = derived from the country. */
  readonly einvoiceRegime: EinvoiceRegime | null;
  /** 52-12 (0310): the structured seller address an e-invoice needs; `null` = not given. */
  readonly addressJson: StructuredAddress | null;
}

export function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** Country from the organization's locale region (`ar-SA` → SA), else Saudi Arabia. */
export function defaultProfile(
  organization: { readonly name: string; readonly defaultLocale: string } | null,
): FinanceProfileValues {
  const region = /-([A-Z]{2})\b/u.exec(organization?.defaultLocale ?? '')?.[1];
  const country = region !== undefined && region in COUNTRY_DEFAULTS ? region : FALLBACK_COUNTRY;
  const defaults = COUNTRY_DEFAULTS[country] ?? { currency: 'USD', taxBp: 0 };
  return {
    country,
    baseCurrency: defaults.currency,
    taxRegistrationNo: null,
    taxScheme: 'VAT',
    defaultTaxRateBp: defaults.taxBp,
    legalNameEn: organization?.name ?? null,
    legalNameAr: null,
    addressEn: null,
    addressAr: null,
    invoicePrefix: 'INV',
    quotePrefix: 'QT',
    creditNotePrefix: 'CN',
    numberingReset: 'yearly',
    roundingMinutes: 15,
    weekStart: 0,
    digits: 'latn',
    showHijri: false,
    bankDetailsText: null,
    paymentTermsDays: 30,
    vatRegistrationStatus: 'not_registered',
    einvoiceRegime: null,
    addressJson: null,
  };
}

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('body', 'must be an object');
  }
  return body as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string') throw invalid(field, 'must be text');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max)
    throw invalid(field, `must be 1 to ${max} characters`);
  if (pattern !== undefined && !pattern.test(trimmed))
    throw invalid(field, 'has an invalid format');
  return trimmed;
}

function nullableText(value: unknown, field: string, max: number, pattern?: RegExp): string | null {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return text(value, field, max, pattern);
}

export function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, list: readonly T[]): T {
  const found = list.find((item) => item === value);
  if (found === undefined) throw invalid(field, `must be one of ${list.join(', ')}`);
  return found;
}

export function currency(value: unknown, field: string): string {
  return oneOf(value, field, FINANCE_CURRENCIES);
}

const PREFIX = /^[A-Z0-9-]{1,16}$/u;

/**
 * 52-12 — `addressJson` in a PUT: an object (unknown keys dropped, text trimmed ≤ 120), `null` or
 * an all-empty object clears it. A non-object, a non-text field or a wrongly shaped SA building
 * number / postal code is a 400.
 */
export function validateAddressJson(value: unknown, country: string): StructuredAddress | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('addressJson', 'must be an object or null');
  }
  const input = value as Record<string, unknown>;
  for (const field of ADDRESS_FIELDS) {
    const item = input[field];
    if (item !== undefined && item !== null && typeof item !== 'string') {
      throw invalid(`addressJson.${field}`, 'must be text');
    }
  }
  const address = parseAddressJson(input);
  if (address === null) return null;
  const errors = addressFormatErrors(address, country);
  if (errors[0] !== undefined) throw invalid(`addressJson.${errors[0]}`, 'has an invalid format');
  return address;
}
const TRN = /^[A-Za-z0-9-]{3,32}$/u;

/** A PUT body merged over the current (or default) profile: absent fields keep their value. */
export function validateProfile(
  body: unknown,
  current: FinanceProfileValues,
): FinanceProfileValues {
  const input = record(body);
  const country =
    input['country'] === undefined ? current.country : text(input['country'], 'country', 2);
  const pick = <K extends keyof FinanceProfileValues>(
    key: K,
    parse: (value: unknown) => FinanceProfileValues[K],
  ): FinanceProfileValues[K] => (input[key] === undefined ? current[key] : parse(input[key]));
  return {
    country: pick('country', (v) => text(v, 'country', 2, /^[A-Z]{2}$/u)),
    baseCurrency: pick('baseCurrency', (v) => currency(v, 'baseCurrency')),
    taxRegistrationNo: pick('taxRegistrationNo', (v) =>
      nullableText(v, 'taxRegistrationNo', 32, TRN),
    ),
    taxScheme: pick('taxScheme', (v) => oneOf(v, 'taxScheme', ['VAT', 'GST', 'NONE'])),
    defaultTaxRateBp: pick('defaultTaxRateBp', (v) =>
      wholeNumber(v, 'defaultTaxRateBp', 0, 10_000),
    ),
    legalNameEn: pick('legalNameEn', (v) => nullableText(v, 'legalNameEn', 200)),
    legalNameAr: pick('legalNameAr', (v) => nullableText(v, 'legalNameAr', 200)),
    addressEn: pick('addressEn', (v) => nullableText(v, 'addressEn', 500)),
    addressAr: pick('addressAr', (v) => nullableText(v, 'addressAr', 500)),
    invoicePrefix: pick('invoicePrefix', (v) => text(v, 'invoicePrefix', 16, PREFIX)),
    quotePrefix: pick('quotePrefix', (v) => text(v, 'quotePrefix', 16, PREFIX)),
    creditNotePrefix: pick('creditNotePrefix', (v) => text(v, 'creditNotePrefix', 16, PREFIX)),
    numberingReset: pick('numberingReset', (v) => oneOf(v, 'numberingReset', NUMBERING_RESETS)),
    roundingMinutes: pick('roundingMinutes', (v) => wholeNumber(v, 'roundingMinutes', 1, 60)),
    weekStart: pick('weekStart', (v) => wholeNumber(v, 'weekStart', 0, 6)),
    digits: pick('digits', (v) => oneOf(v, 'digits', DIGIT_SYSTEMS)),
    showHijri: pick('showHijri', (v) => {
      if (typeof v !== 'boolean') throw invalid('showHijri', 'must be true or false');
      return v;
    }),
    bankDetailsText: pick('bankDetailsText', (v) => nullableText(v, 'bankDetailsText', 2000)),
    paymentTermsDays: pick('paymentTermsDays', (v) => wholeNumber(v, 'paymentTermsDays', 0, 365)),
    vatRegistrationStatus: pick('vatRegistrationStatus', (v) =>
      oneOf(v, 'vatRegistrationStatus', VAT_REGISTRATION_STATUSES),
    ),
    einvoiceRegime: pick('einvoiceRegime', (v) =>
      v === null ? null : oneOf(v, 'einvoiceRegime', EINVOICE_REGIMES),
    ),
    addressJson: pick('addressJson', (v) => validateAddressJson(v, country)),
  };
}

export interface TaxRateInput {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly rateBp: number;
  readonly zatcaCategory: ZatcaCategory | null;
  readonly isDefault: boolean;
}

export function validateTaxRate(body: unknown, current?: TaxRateInput): TaxRateInput {
  const input = record(body);
  const has = (key: string): boolean => input[key] !== undefined || current === undefined;
  return {
    code:
      current === undefined ? text(input['code'], 'code', 16, /^[A-Z0-9_]{1,16}$/u) : current.code,
    nameEn: has('nameEn') ? text(input['nameEn'], 'nameEn', 64) : (current?.nameEn ?? ''),
    nameAr: has('nameAr') ? text(input['nameAr'], 'nameAr', 64) : (current?.nameAr ?? ''),
    rateBp: has('rateBp')
      ? wholeNumber(input['rateBp'], 'rateBp', 0, 10_000)
      : (current?.rateBp ?? 0),
    zatcaCategory:
      input['zatcaCategory'] === undefined
        ? (current?.zatcaCategory ?? null)
        : input['zatcaCategory'] === null
          ? null
          : oneOf(input['zatcaCategory'], 'zatcaCategory', ZATCA_CATEGORIES),
    isDefault:
      input['isDefault'] === undefined
        ? (current?.isDefault ?? false)
        : input['isDefault'] === true,
  };
}

/** The four rates every organization starts with, seeded on the first read. */
export function seedTaxRates(defaultTaxRateBp: number): readonly TaxRateInput[] {
  return [
    {
      code: 'STD',
      nameEn: 'Standard',
      nameAr: 'قياسي',
      rateBp: defaultTaxRateBp,
      zatcaCategory: 'S',
      isDefault: true,
    },
    {
      code: 'ZERO',
      nameEn: 'Zero-rated',
      nameAr: 'نسبة صفر',
      rateBp: 0,
      zatcaCategory: 'Z',
      isDefault: false,
    },
    {
      code: 'EXEMPT',
      nameEn: 'Exempt',
      nameAr: 'معفى',
      rateBp: 0,
      zatcaCategory: 'E',
      isDefault: false,
    },
    {
      code: 'OOS',
      nameEn: 'Out of scope',
      nameAr: 'خارج النطاق',
      rateBp: 0,
      zatcaCategory: 'O',
      isDefault: false,
    },
  ];
}

export interface ExchangeRateInput {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** DECIMAL(18,8) as text, never a float. */
  readonly rate: string;
  readonly effectiveOn: string;
}

export function validateExchangeRate(body: unknown): ExchangeRateInput {
  const input = record(body);
  const fromCurrency = currency(input['fromCurrency'], 'fromCurrency');
  const toCurrency = currency(input['toCurrency'], 'toCurrency');
  if (fromCurrency === toCurrency) throw invalid('toCurrency', 'must differ from fromCurrency');
  const raw = typeof input['rate'] === 'number' ? String(input['rate']) : input['rate'];
  if (typeof raw !== 'string' || !/^\d{1,10}(\.\d{1,8})?$/u.test(raw) || !/[1-9]/u.test(raw)) {
    throw invalid('rate', 'must be a positive decimal with at most 10 + 8 digits');
  }
  const effectiveOn = input['effectiveOn'];
  if (
    typeof effectiveOn !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(effectiveOn) ||
    Number.isNaN(Date.parse(`${effectiveOn}T00:00:00Z`)) ||
    new Date(`${effectiveOn}T00:00:00Z`).toISOString().slice(0, 10) !== effectiveOn
  ) {
    throw invalid('effectiveOn', 'must be a calendar date YYYY-MM-DD');
  }
  return { fromCurrency, toCurrency, rate: raw, effectiveOn };
}

export interface FinanceReadiness {
  readonly ready: boolean;
  readonly invoicing: readonly string[];
  readonly einvoicing: readonly string[];
  /** 52-12: the regime in force (the override, else the country's). */
  readonly einvoicingRegime: EinvoiceRegime;
  /** 52-12: nothing left on the regime's checklist (`none` → true). */
  readonly einvoicingReady: boolean;
}

/** ZATCA VAT registration number: 15 digits, first and last digit 3. */
export const ZATCA_VAT_NUMBER = /^3\d{13}3$/u;

/**
 * 52-12 — the per-regime e-invoicing checklist (keys; the web maps them to copy). `certificate`
 * (ZATCA CSID), `peppol_id` (an accredited PINT-AE service provider) and `activity_code` (ETA) stay
 * listed until a later pass stores them.
 */
export function einvoicingChecklist(
  profile: FinanceProfileValues,
  regime: EinvoiceRegime,
): readonly string[] {
  const trn = profile.taxRegistrationNo;
  switch (regime) {
    case 'zatca':
      return [
        ...(trn === null || !ZATCA_VAT_NUMBER.test(trn) ? ['tax_registration_no'] : []),
        ...(profile.legalNameAr === null ? ['legal_name_ar'] : []),
        ...(addressMissing(profile.addressJson, 'SA').length > 0 ? ['address_structured'] : []),
        'certificate',
      ];
    case 'pint_ae':
      return [...(trn === null ? ['tax_registration_no'] : []), 'peppol_id'];
    case 'eta':
      return [...(trn === null ? ['tax_registration_no'] : []), 'activity_code'];
    case 'none':
      return [];
  }
}

/** What is missing: `invoicing` blocks issuing an invoice; `einvoicing` only the e-invoice path. */
export function readiness(
  profile: FinanceProfileValues,
  saved: boolean,
  activeTaxRates: number,
): FinanceReadiness {
  const invoicing: string[] = [];
  if (!saved) invoicing.push('profile_not_saved');
  if (profile.legalNameEn === null && profile.legalNameAr === null) invoicing.push('legal_name');
  if (activeTaxRates === 0) invoicing.push('tax_rates');
  const einvoicingRegime = resolvedRegime(profile.country, profile.einvoiceRegime);
  const einvoicing = einvoicingChecklist(profile, einvoicingRegime);
  return {
    ready: invoicing.length === 0,
    invoicing,
    einvoicing,
    einvoicingRegime,
    einvoicingReady: einvoicing.length === 0,
  };
}

/** The TRN as the audit trail keeps it: last four characters only. */
export function maskTrn(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

/** `{field, before, after}` for every changed field; the TRN is masked to its last four. */
export function profileChanges(
  before: FinanceProfileValues,
  after: FinanceProfileValues,
): { readonly field: string; readonly before: unknown; readonly after: unknown }[] {
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  for (const key of Object.keys(after) as (keyof FinanceProfileValues)[]) {
    if (before[key] === after[key]) continue;
    if (key === 'addressJson' && JSON.stringify(before[key]) === JSON.stringify(after[key])) {
      continue;
    }
    const mask = key === 'taxRegistrationNo';
    changes.push({
      field: key,
      before: mask ? maskTrn(before[key] as string | null) : before[key],
      after: mask ? maskTrn(after[key] as string | null) : after[key],
    });
  }
  return changes;
}

/**
 * B6: the "not a tax invoice" line names only the authority of the seller's country — ZATCA for
 * KSA, ETA for Egypt; any other country keeps the shared two-authority wording.
 */
const TAX_NOTICE_BY_COUNTRY: Readonly<
  Record<string, { readonly en: string; readonly ar: string }>
> = {
  SA: {
    en: 'This document is not a tax invoice. A tax invoice will follow once it is registered with ZATCA.',
    ar: 'هذه الوثيقة ليست فاتورة ضريبية. سيتم إصدار الفاتورة الضريبية بعد تسجيلها لدى هيئة الزكاة والضريبة والجمارك.',
  },
  EG: {
    en: 'This document is not a tax invoice. A tax invoice will follow once it is registered with ETA.',
    ar: 'هذه الوثيقة ليست فاتورة ضريبية. سيتم إصدار الفاتورة الضريبية بعد تسجيلها لدى مصلحة الضرائب المصرية.',
  },
};

export function taxNoticeFor(country: string | null | undefined, lang: 'en' | 'ar' | 'bi'): string {
  const copy = TAX_NOTICE_BY_COUNTRY[(country ?? '').toUpperCase()];
  if (copy === undefined) return taxNoticeCopy(lang);
  if (lang === 'bi') return `${copy.en}\n${copy.ar}`;
  return copy[lang];
}
