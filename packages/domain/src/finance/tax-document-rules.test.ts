import { describe, expect, it } from 'vitest';
import {
  canUseLabel,
  defaultLabelFor,
  isValidTaxRef,
  labelCopy,
  resolvedRegime,
  taxNoticeCopy,
  taxNoticeRequired,
} from './tax-document-rules.js';

/** UNIT-52-27 — tax-document rules per country. */
describe('UNIT-52-27 tax-document rules', () => {
  it('defaults a registered SA/EG org to proforma, everyone else (and the unregistered) to invoice', () => {
    expect(defaultLabelFor('SA', 'registered')).toBe('proforma');
    expect(defaultLabelFor('EG', 'registered')).toBe('proforma');
    expect(defaultLabelFor('SA', 'not_registered')).toBe('invoice');
    expect(defaultLabelFor('AE', 'registered')).toBe('invoice');
    expect(defaultLabelFor('DE', 'registered')).toBe('invoice');
  });

  it('refuses tax_invoice without a reference in SA/EG and allows it with one', () => {
    const base = { vatStatus: 'registered', label: 'tax_invoice' as const };
    expect(canUseLabel({ ...base, country: 'SA', taxRegistrationRef: null })).toEqual({
      ok: false,
      reason: 'tax_invoice_requires_registration',
    });
    expect(
      canUseLabel({ ...base, country: 'EG', taxRegistrationRef: 'ABCDEFGHJK0123456789ABCDEF' }),
    ).toEqual({ ok: true });
    expect(canUseLabel({ ...base, country: 'DE', taxRegistrationRef: null })).toEqual({ ok: true });
    expect(
      canUseLabel({ ...base, country: 'DE', vatStatus: 'not_registered', taxRegistrationRef: null })
        .ok,
    ).toBe(false);
    expect(
      canUseLabel({
        country: 'SA',
        vatStatus: 'registered',
        label: 'commercial',
        taxRegistrationRef: null,
      }).ok,
    ).toBe(true);
  });

  it('requires the notice in SA/EG on anything but a tax invoice; never in AE/DE', () => {
    expect(taxNoticeRequired('SA', 'proforma')).toBe(true);
    expect(taxNoticeRequired('EG', 'invoice')).toBe(true);
    expect(taxNoticeRequired('EG', 'tax_invoice')).toBe(false);
    expect(taxNoticeRequired('AE', 'proforma')).toBe(false);
    expect(taxNoticeRequired('DE', 'invoice')).toBe(false);
  });

  it('checks the reference shape per regime and resolves an override', () => {
    expect(isValidTaxRef('eta', 'ABCDEFGHJK0123456789ABCDEF')).toBe(true);
    expect(isValidTaxRef('eta', 'abc')).toBe(false);
    expect(isValidTaxRef('zatca', '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e')).toBe(true);
    expect(isValidTaxRef('zatca', 'not-a-uuid')).toBe(false);
    expect(isValidTaxRef('none', 'X'.repeat(65))).toBe(false);
    expect(isValidTaxRef('none', 'ACC-2026/0042')).toBe(true);
    expect(resolvedRegime('SA', null)).toBe('zatca');
    expect(resolvedRegime('SA', 'none')).toBe('none');
  });

  it('words the labels and the notice in EN/AR', () => {
    expect(labelCopy('proforma', 'ar')).toBe('فاتورة مبدئية');
    expect(labelCopy('commercial', 'bi')).toBe('Commercial invoice / فاتورة تجارية');
    expect(taxNoticeCopy('en')).toMatch(/^This document is not a tax invoice\./u);
    expect(taxNoticeCopy('ar')).toContain('ليست فاتورة ضريبية');
  });
});
