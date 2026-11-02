import { describe, expect, it } from 'vitest';
import type { StructuredAddress } from './address.js';
import { buildUblInvoice, taxSubtotals, xmlHash } from './ubl.js';
import type { UblInvoiceInput } from './ubl.js';

/** 52-12 (R21-c) — UBL 2.1 invoice XML (ZATCA layout / PINT-AE switch), unsigned. */
const address: StructuredAddress = {
  building: '1234',
  street: 'King Fahd Rd',
  district: 'Al Olaya',
  city: 'الرياض',
  postalCode: '12345',
  countryCode: 'SA',
};

const base: UblInvoiceInput = {
  profile: 'zatca',
  id: '0190f0e2-7c1a-7b3e-9d2a-1a2b3c4d5e6f',
  number: 'INV-2026-0001',
  kind: 'invoice',
  issueDate: '2026-11-02',
  supplyDate: '2026-11-01',
  currency: 'SAR',
  seller: { legalName: 'Studio & Co', vatNumber: '310122393500003', address },
  buyer: { legalName: 'Client', vatNumber: '300000000000003', address },
  icv: null,
  pih: null,
  lines: [
    {
      position: 1,
      description: 'Design & build',
      quantity: 1,
      unitPriceMinor: 100_000,
      lineNetMinor: 100_000,
      lineTaxMinor: 15_000,
      taxCategory: 'S',
      taxRateBp: 1500,
    },
    {
      position: 2,
      description: 'Export service',
      quantity: 2,
      unitPriceMinor: 5_000,
      lineNetMinor: 10_000,
      lineTaxMinor: 0,
      taxCategory: 'Z',
      taxRateBp: 0,
    },
    {
      position: 3,
      description: 'Hosting',
      quantity: 1,
      unitPriceMinor: 20_000,
      lineNetMinor: 20_000,
      lineTaxMinor: 3_000,
      taxCategory: 'S',
      taxRateBp: 1500,
    },
  ],
  totals: { subtotalMinor: 130_000, discountMinor: 0, taxMinor: 18_000, totalMinor: 148_000 },
};

describe('buildUblInvoice', () => {
  it('marks a B2B invoice 388/0100000, a B2C one 0200000 and a credit note 381', () => {
    const b2b = buildUblInvoice(base);
    expect(b2b.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(b2b).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(b2b).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(b2b).toContain('<cbc:CityName>الرياض</cbc:CityName>');
    expect(b2b).not.toContain('UBLExtensions');
    expect(b2b).not.toContain('>ICV<');
    const b2c = buildUblInvoice({ ...base, buyer: { ...base.buyer, vatNumber: null } });
    expect(b2c).toContain('name="0200000">388<');
    const credit = buildUblInvoice({ ...base, kind: 'credit_note' });
    expect(credit).toContain('<cbc:CreditNoteTypeCode name="0100000">381</cbc:CreditNoteTypeCode>');
    expect(credit).toContain('<cac:CreditNoteLine>');
  });

  it('escapes text, prints KWD with three places and switches to the PINT-AE ids', () => {
    expect(buildUblInvoice(base)).toContain('<cbc:Name>Design &amp; build</cbc:Name>');
    const kwd = buildUblInvoice({ ...base, currency: 'KWD' });
    expect(kwd).toContain('<cbc:PayableAmount currencyID="KWD">148.000</cbc:PayableAmount>');
    const ae = buildUblInvoice({ ...base, profile: 'pint_ae', icv: 7, pih: 'abc=' });
    expect(ae).toContain(
      '<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>',
    );
    expect(ae).toContain('<cbc:InvoiceTypeCode>388</cbc:InvoiceTypeCode>');
    expect(ae).toContain('<cbc:ID>ICV</cbc:ID><cbc:UUID>7</cbc:UUID>');
  });

  it('groups tax by category, sums to the tax total and hashes stably', () => {
    const groups = taxSubtotals('zatca', base.lines);
    expect(groups.map((g) => [g.category, g.taxableMinor, g.taxMinor, g.reasonCode])).toEqual([
      ['S', 120_000, 18_000, null],
      ['Z', 10_000, 0, 'VATEX-SA-33'],
    ]);
    expect(groups.reduce((sum, g) => sum + g.taxMinor, 0)).toBe(base.totals.taxMinor);
    const xml = buildUblInvoice(base);
    expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-SA-33</cbc:TaxExemptionReasonCode>');
    expect(xmlHash(xml)).toMatch(/^[0-9a-f]{64}$/u);
    expect(xmlHash(buildUblInvoice(base))).toBe(xmlHash(xml));
  });
});
