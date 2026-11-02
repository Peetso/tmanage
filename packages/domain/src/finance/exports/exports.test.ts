import { describe, expect, it } from 'vitest';
import {
  EXPORT_KINDS,
  EXPORT_TARGETS,
  TARGET_MAPS,
  TARGET_VALIDATORS,
  buildExport,
  minorToDecimal,
  parseCsv,
} from './index.js';
import type { ExportInput } from './index.js';

/**
 * UNIT-52-15 — one fixture round-trip per target through its own validator (header verbatim,
 * required cells, vendor date format, 2-decimal amounts, mapped tax codes). UNIT-52-16 — a
 * description that starts like a formula comes out neutralised.
 */

const FIXTURE: ExportInput = {
  invoices: [
    {
      id: '0190a000-0000-7000-8000-0000000000b1',
      number: 'INV-2026-0001',
      kind: 'standard',
      state: 'sent',
      issueDate: '2026-10-05',
      dueDate: '2026-10-20',
      supplyDate: '2026-10-01',
      currency: 'SAR',
      fxRate: null,
      subtotalMinor: 450_000,
      discountMinor: 0,
      taxMinor: 67_500,
      totalMinor: 517_500,
      poNumber: 'PO-7',
      notes: 'Thank you',
      terms: null,
      customerId: '0190a000-0000-7000-8000-0000000000c1',
      customerName: 'Acme Trading',
      customerNameAr: 'أكمي للتجارة',
      customerEmail: 'ap@acme.example',
      customerAddress: 'Olaya St, Riyadh',
      lines: [
        {
          position: 0,
          descriptionEn: 'Design',
          descriptionAr: 'تصميم',
          quantityCenti: 1000,
          unit: 'hour',
          unitPriceMinor: 30_000,
          discountBp: 0,
          taxBp: 1500,
          taxCategory: 'S',
          lineDiscountMinor: 0,
          lineNetMinor: 300_000,
          lineTaxMinor: 45_000,
          lineGrossMinor: 345_000,
        },
        {
          position: 1,
          descriptionEn: '=cmd|"/c calc"!A1',
          descriptionAr: null,
          quantityCenti: 150,
          unit: 'item',
          unitPriceMinor: 100_000,
          discountBp: 0,
          taxBp: 1500,
          taxCategory: null,
          lineDiscountMinor: 0,
          lineNetMinor: 150_000,
          lineTaxMinor: 22_500,
          lineGrossMinor: 172_500,
        },
      ],
    },
  ],
  creditNotes: [
    {
      id: '0190a000-0000-7000-8000-0000000000d1',
      number: 'CN-2026-0001',
      invoiceId: '0190a000-0000-7000-8000-0000000000b1',
      invoiceNumber: 'INV-2026-0001',
      issueDate: '2026-10-25',
      currency: 'SAR',
      reason: 'Partial refund',
      subtotalMinor: 100_000,
      taxMinor: 15_000,
      totalMinor: 115_000,
      customerId: '0190a000-0000-7000-8000-0000000000c1',
      customerName: 'Acme Trading',
      customerNameAr: null,
      lines: [
        {
          position: 0,
          descriptionEn: null,
          descriptionAr: 'خصم',
          quantityCenti: 100,
          unit: 'item',
          unitPriceMinor: 100_000,
          taxBp: 1500,
          lineNetMinor: 100_000,
          lineTaxMinor: 15_000,
          lineGrossMinor: 115_000,
        },
      ],
    },
  ],
  payments: [
    {
      id: '0190a000-0000-7000-8000-0000000000e1',
      invoiceId: '0190a000-0000-7000-8000-0000000000b1',
      invoiceNumber: 'INV-2026-0001',
      paidOn: '2026-10-18',
      amountMinor: 200_000,
      currency: 'SAR',
      method: 'transfer',
      reference: 'TRX 991',
      customerId: '0190a000-0000-7000-8000-0000000000c1',
      customerName: 'Acme Trading',
      customerNameAr: null,
    },
  ],
  customers: [
    {
      id: '0190a000-0000-7000-8000-0000000000c1',
      name: 'Acme',
      legalNameEn: 'Acme Trading',
      legalNameAr: 'أكمي للتجارة',
      taxRegistrationNo: '300000000000003',
      billingAddressEn: 'Olaya St, Riyadh',
      billingAddressAr: 'شارع العليا، الرياض',
      billingEmail: 'ap@acme.example',
      defaultCurrency: 'SAR',
    },
  ],
  expenses: [
    {
      id: '0190a000-0000-7000-8000-0000000000f1',
      spentOn: '2026-10-07',
      category: 'travel',
      amountMinor: 12_345,
      currency: 'SAR',
      taxBp: 0,
      billable: true,
      markupBp: 1000,
      note: 'Taxi',
      submitterName: 'Sara Ali',
    },
  ],
};

describe('UNIT-52-15 — every target round-trips through its validator', () => {
  it.each(EXPORT_TARGETS)('%s', (target) => {
    const built = buildExport({ ...FIXTURE, target, kinds: EXPORT_KINDS });
    expect(built.files.map((file) => file.name)).toEqual(
      TARGET_MAPS[target].files.map((file) => file.name),
    );
    expect(TARGET_VALIDATORS[target](built.files)).toEqual([]);
    expect(built.rowCounts).toEqual({
      invoices: 1,
      credit_notes: 1,
      payments: 1,
      customers: 1,
      expenses: 1,
    });
    expect(built.readme.text).toContain(`template dated ${TARGET_MAPS[target].templateCheckedOn}`);
    expect(built.readme.text).toContain('البيانات الشخصية');
  });

  it('the validator refuses a broken date, a 1-decimal amount and an unmapped tax code', () => {
    const built = buildExport({ ...FIXTURE, target: 'xero', kinds: ['invoices'] });
    const broken = built.files[0]!.text.replace('05/10/2026', '2026-10-05')
      .replace('300.00', '300.0')
      .replace(',OUTPUT,', ',VAT15,');
    expect(TARGET_VALIDATORS.xero([{ name: built.files[0]!.name, text: broken }])).toHaveLength(3);
  });
});

describe('UNIT-52-16 — CSV injection guard and Latin-only', () => {
  it('a description starting with = is written as text', () => {
    const built = buildExport({ ...FIXTURE, target: 'generic', kinds: ['invoices'] });
    const cells = parseCsv(built.files[0]!.text).flat();
    expect(cells).toContain(`'=cmd|"/c calc"!A1`);
    expect(cells.some((cell) => cell.startsWith('='))).toBe(false);
  });

  it('Latin-only strips Arabic from descriptions and blanks the Arabic columns', () => {
    const built = buildExport({
      ...FIXTURE,
      target: 'generic',
      kinds: EXPORT_KINDS,
      latinOnly: true,
    });
    for (const file of built.files) expect(file.text).not.toMatch(/[\u0600-\u06FF]/u);
    const plain = buildExport({ ...FIXTURE, target: 'zoho_books', kinds: ['invoices'] });
    expect(plain.files[0]!.text).toContain('Design / تصميم');
  });

  it('only the expenses kind carries a person name', () => {
    const without = buildExport({
      ...FIXTURE,
      target: 'generic',
      kinds: ['invoices', 'credit_notes', 'payments', 'customers'],
    });
    for (const file of without.files) expect(file.text).not.toContain('Sara Ali');
    const withExpenses = buildExport({ ...FIXTURE, target: 'generic', kinds: ['expenses'] });
    expect(withExpenses.files[0]!.text).toContain('Sara Ali');
  });

  it('minor units keep 2 decimals, 3 for three-digit currencies', () => {
    expect(minorToDecimal(12_345, 'SAR')).toBe('123.45');
    expect(minorToDecimal(1_005, 'KWD')).toBe('1.005');
    expect(minorToDecimal(1_500, 'JPY')).toBe('1500.00');
  });
});
