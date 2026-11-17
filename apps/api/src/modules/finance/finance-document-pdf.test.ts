import { describe, expect, it } from 'vitest';
import { accentColour } from '../approvals/record-pdf.js';
import type { InvoiceView } from './client-invoices.service.js';
import {
  documentFileName,
  documentLanguage,
  invoicePdfDocument,
  renderDocumentPdf,
} from './finance-document-pdf.js';

const party = {
  nameEn: 'Acme',
  nameAr: 'أكمي',
  taxRegistrationNo: null,
  addressEn: null,
  addressAr: null,
};
const view = {
  number: 'INV-2026-0001',
  documentLabel: 'invoice',
  currency: 'SAR',
  issueDate: '2026-11-01',
  dueDate: '2026-11-16',
  poNumber: null,
  contentHash: null,
  lines: [
    {
      descriptionEn: 'Design',
      descriptionAr: 'تصميم',
      quantity: 1.5,
      unit: 'hour',
      unitPriceMinor: 20_000,
      taxBp: 1500,
      lineGrossMinor: 34_500,
    },
  ],
  subtotalMinor: 30_000,
  discountMinor: 0,
  taxByRate: [{ taxBp: 1500, netMinor: 30_000, taxMinor: 4_500 }],
  taxMinor: 4_500,
  depositAppliedMinor: 0,
  totalMinor: 34_500,
  paidMinor: 0,
  amountDueMinor: 34_500,
  amountInWords: { en: 'Three hundred forty-five riyals', ar: 'ثلاثمائة وخمسة وأربعون ريالاً' },
  terms: null,
  notes: null,
  internalNote: 'margin is thin',
  taxRegistrationRef: null,
} as unknown as InvoiceView;
const options = {
  notice: false,
  parties: { seller: party, buyer: party },
  country: 'SA',
  brand: { name: 'Northstar', accent: '#2563eb' },
};

describe('52-10 invoice and quote PDF', () => {
  it('names the file from the sanitised number only', () => {
    expect(documentFileName('invoice', 'INV/2026"\r\n../0001')).toBe(
      'invoice-INV-2026-..-0001.pdf',
    );
    expect(documentFileName('quote', null)).toBe('quote-draft.pdf');
    expect(documentLanguage('xx', 'ar')).toBe('ar');
    expect(documentLanguage(undefined, 'de')).toBe('en');
  });

  it('prints the stored amounts and the brand, never the internal note', () => {
    const doc = invoicePdfDocument(view, 'ar', options);
    const text = JSON.stringify(doc);
    expect(text).toContain('345.00 SAR');
    expect(text).toContain('45.00 SAR');
    expect(text).toContain('تصميم');
    expect(doc.subtitle.startsWith('Northstar')).toBe(true);
    expect(text).not.toContain('margin is thin');
  });

  it('draws Arabic through the shared writer and reads the stored accent', async () => {
    const file = await renderDocumentPdf(
      'invoice',
      view.number,
      invoicePdfDocument(view, 'bi', options),
    );
    expect(file.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file.fileName).toBe('invoice-INV-2026-0001.pdf');
    expect(accentColour('#ff0000')).toMatchObject({ red: 1, green: 0, blue: 0 });
    expect(accentColour('red')).toMatchObject({ red: 0, green: 0, blue: 0 });
  });
});
