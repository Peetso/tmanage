import { describe, expect, it } from 'vitest';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { DocumentSequenceService, periodKeyFor } from './document-sequences.js';
import type { DocumentSequenceStore } from './document-sequences.js';
import {
  defaultProfile,
  profileChanges,
  readiness,
  validateExchangeRate,
  validateProfile,
  validateTaxRate,
} from './finance-rules.js';
import { taxDocumentRulesFor } from './finance.service.js';

/** An in-memory store whose `lockAndTake` serializes issuers on a per-row lock, like FOR UPDATE. */
function fakeStore(timeZone: string): DocumentSequenceStore {
  const rows = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();
  return {
    settings: () => Promise.resolve({ prefix: 'INV', reset: 'yearly', timeZone }),
    ensure: (_tx, org, kind, period) => {
      const key = `${org}/${kind}/${period}`;
      if (!rows.has(key)) rows.set(key, 1);
      return Promise.resolve();
    },
    lockAndTake: async (_tx, org, kind, period) => {
      const key = `${org}/${kind}/${period}`;
      const previous = locks.get(key) ?? Promise.resolve();
      let release = (): void => undefined;
      locks.set(key, new Promise<void>((resolve) => (release = resolve)));
      await previous;
      const value = rows.get(key) ?? 1;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      rows.set(key, value + 1);
      release();
      return value;
    },
  };
}

const tx = {} as TenantQueryRunner;

describe('52-23 finance foundations', () => {
  it('issues gapless, unique numbers to 20 concurrent issuers', async () => {
    const service = new DocumentSequenceService(fakeStore('Asia/Riyadh'));
    const at = new Date('2026-06-01T10:00:00Z');
    const issued = await Promise.all(
      Array.from({ length: 20 }, () => service.nextNumber(tx, 'org-1', 'invoice', at)),
    );
    expect(issued.map((n) => n.value).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(issued.find((n) => n.value === 7)?.number).toBe('INV-2026-0007');
  });

  it('resets yearly on 1 January in the organization time zone', async () => {
    // 2026-12-31 22:30 UTC is already 2027 in Riyadh (UTC+3) but still 2026 in UTC.
    const at = new Date('2026-12-31T22:30:00Z');
    expect(periodKeyFor(at, 'Asia/Riyadh', 'yearly')).toBe('2027');
    expect(periodKeyFor(at, 'UTC', 'yearly')).toBe('2026');
    expect(periodKeyFor(at, 'Not/AZone', 'yearly')).toBe('2026');
    expect(periodKeyFor(at, 'Asia/Riyadh', 'never')).toBe('0000');
    const first = await new DocumentSequenceService(fakeStore('Asia/Riyadh')).nextNumber(
      tx,
      'o',
      'invoice',
      at,
    );
    expect(first.number).toBe('INV-2027-0001');
  });

  it('validates rate_bp 0–10000 and ISO currency codes', () => {
    expect(() =>
      validateTaxRate({ code: 'STD', nameEn: 'a', nameAr: 'b', rateBp: 10_001 }),
    ).toThrow();
    expect(validateTaxRate({ code: 'VAT5', nameEn: 'a', nameAr: 'b', rateBp: 500 }).rateBp).toBe(
      500,
    );
    expect(() =>
      validateExchangeRate({
        fromCurrency: 'usd',
        toCurrency: 'SAR',
        rate: '3.75',
        effectiveOn: '2026-10-30',
      }),
    ).toThrow();
    expect(() =>
      validateExchangeRate({
        fromCurrency: 'USD',
        toCurrency: 'SAR',
        rate: '0',
        effectiveOn: '2026-10-30',
      }),
    ).toThrow();
    expect(() =>
      validateExchangeRate({
        fromCurrency: 'USD',
        toCurrency: 'SAR',
        rate: '3.75',
        effectiveOn: '2026-02-30',
      }),
    ).toThrow();
  });

  it('keeps only the last four TRN characters in the audit changes and reports readiness', () => {
    const before = defaultProfile({ name: 'Acme', defaultLocale: 'ar-SA' });
    expect([before.country, before.baseCurrency, before.defaultTaxRateBp]).toEqual([
      'SA',
      'SAR',
      1500,
    ]);
    const after = { ...before, taxRegistrationNo: '300123456700003' };
    expect(profileChanges(before, after)).toEqual([
      { field: 'taxRegistrationNo', before: null, after: '****0003' },
    ]);
    expect(readiness(before, false, 4)).toMatchObject({
      ready: false,
      invoicing: ['profile_not_saved'],
    });
    expect(readiness(after, true, 4).einvoicing).toEqual([
      'legal_name_ar',
      'address_structured',
      'certificate',
    ]);
  });
});

/** 52-12 (R21-c) — the per-regime e-invoicing checklist and the structured address. */
describe('52-12 e-invoicing readiness', () => {
  const sa = defaultProfile({ name: 'Acme', defaultLocale: 'ar-SA' });
  const address = {
    building: '1234',
    street: 'King Fahd Rd',
    district: 'Al Olaya',
    city: 'Riyadh',
    postalCode: '12345',
    countryCode: 'SA',
  };

  it('lists a 14-digit TRN, drops the address once complete, lists peppol_id for PINT-AE', () => {
    const short = readiness({ ...sa, taxRegistrationNo: '31012239350003' }, true, 4);
    expect(short).toMatchObject({ einvoicingRegime: 'zatca', einvoicingReady: false });
    expect(short.einvoicing).toContain('tax_registration_no');
    const full = validateProfile(
      { taxRegistrationNo: '310122393500003', legalNameAr: 'أكمي', addressJson: address },
      sa,
    );
    expect(readiness(full, true, 4).einvoicing).toEqual(['certificate']);
    const ae = readiness({ ...full, einvoiceRegime: 'pint_ae' }, true, 4);
    expect(ae).toMatchObject({ einvoicingRegime: 'pint_ae', einvoicing: ['peppol_id'] });
    expect(readiness({ ...full, country: 'DE' }, true, 4)).toMatchObject({
      einvoicingRegime: 'none',
      einvoicingReady: true,
    });
  });

  it('refuses a malformed address with 400, clears it with null, ignores unchanged objects', () => {
    expect(() => validateProfile({ addressJson: { building: 'abc' } }, sa)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => validateProfile({ addressJson: 'Riyadh' }, sa)).toThrow();
    const saved = validateProfile({ addressJson: address }, sa);
    expect(validateProfile({ addressJson: null }, saved).addressJson).toBeNull();
    expect(profileChanges(saved, validateProfile({ addressJson: { ...address } }, saved))).toEqual(
      [],
    );
  });
});

/** 52-28 — the profile's VAT status / regime and the resolved tax-document rules. */
describe('52-28 finance profile tax-document fields', () => {
  it('accepts the VAT status and a regime override, refuses an unknown value', () => {
    const base = defaultProfile({ name: 'Acme', defaultLocale: 'ar-EG' });
    expect(base).toMatchObject({ vatRegistrationStatus: 'not_registered', einvoiceRegime: null });
    const saved = validateProfile(
      { vatRegistrationStatus: 'registered', einvoiceRegime: 'eta' },
      base,
    );
    expect(saved).toMatchObject({ vatRegistrationStatus: 'registered', einvoiceRegime: 'eta' });
    expect(validateProfile({ einvoiceRegime: null }, saved).einvoiceRegime).toBeNull();
    expect(() => validateProfile({ vatRegistrationStatus: 'yes' }, base)).toThrow();
    expect(() => validateProfile({ einvoiceRegime: 'peppol' }, base)).toThrow();
  });

  it('resolves the rules for a registered EG org: proforma default, tax invoice gated, notice on', () => {
    const eg = {
      ...defaultProfile({ name: 'Acme', defaultLocale: 'ar-EG' }),
      vatRegistrationStatus: 'registered' as const,
    };
    const rules = taxDocumentRulesFor(eg);
    expect(rules).toMatchObject({
      country: 'EG',
      regime: 'eta',
      defaultLabel: 'proforma',
      noticeRequired: true,
    });
    expect(rules.labels.find((l) => l.label === 'tax_invoice')).toEqual({
      label: 'tax_invoice',
      enabled: false,
      reason: 'tax_invoice_requires_registration',
    });
    const de = taxDocumentRulesFor({ ...eg, country: 'DE' });
    expect(de).toMatchObject({ regime: 'none', defaultLabel: 'invoice', noticeRequired: false });
  });
});
