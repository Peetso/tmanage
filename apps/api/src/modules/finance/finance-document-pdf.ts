import { currencyDigits, labelCopy } from '@tmanage/domain';
import type { OrgBrandingRow } from '../../common/database/schema.js';
import { renderRecordPdf } from '../approvals/record-pdf.js';
import type { PdfDocument, PdfRow, PdfSection } from '../approvals/record-pdf.js';
import type { RecordPdfFile } from '../approvals/record-pdf.service.js';
import { arabicExpenseDescription, unitLabel } from './client-invoices-rules.js';
import { taxNoticeFor } from './finance-rules.js';
import type { InvoiceView, PrintParties, PrintParty } from './client-invoices.service.js';

/**
 * 52-10 — the invoice and quote PDFs, drawn by the one record PDF writer (`approvals/record-pdf.ts`:
 * Helvetica for Latin, the bundled Alexandria face shaped by fontkit for Arabic, bidi-js for mixed
 * lines). Pure functions of a document the service already authorized and loaded: every number is
 * the stored one (lines, tax by rate, totals, amount in words), never recomputed here. Every value
 * is plain text; the internal note and a quote's internal notes are never printed.
 */

export type DocumentLanguage = 'en' | 'ar' | 'bi';

/** The workspace's stored branding: the name it shows and its accent. */
export interface DocumentBrand {
  readonly name: string | null;
  readonly accent: string | null;
}

/** The facts a quote PDF prints: the stored quote, its lines and who it is for. */
export interface QuotePdfFacts {
  readonly number: string;
  readonly title: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly terms: string | null;
  readonly contentHash: string | null;
  readonly recipient: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly unit: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly lineNetMinor: number;
    readonly lineTaxMinor: number;
  }[];
}

/** The language asked for, else the document's own (a stored value outside the list reads 'en'). */
export function documentLanguage(asked: unknown, own: string | null): DocumentLanguage {
  const pick = (value: unknown): DocumentLanguage | null =>
    value === 'en' || value === 'ar' || value === 'bi' ? value : null;
  return pick(asked) ?? pick(own) ?? 'en';
}

/** A stored amount in minor units, grouped, with its currency code (`1,234.50 SAR`). */
export function formatMinor(amountMinor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const negative = amountMinor < 0;
  const text = String(Math.abs(amountMinor)).padStart(digits + 1, '0');
  const whole = digits === 0 ? text : text.slice(0, -digits);
  const fraction = digits === 0 ? '' : `.${text.slice(-digits)}`;
  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}${fraction} ${currency}`;
}

/** A line's description in the document's language(s); one language fills in for the other. */
export function documentDescription(
  english: string | null,
  arabic: string | null,
  language: DocumentLanguage,
): string {
  const en = english ?? arabic ?? '';
  const ar = arabicExpenseDescription(arabic ?? english ?? '');
  if (language === 'ar') return ar;
  if (language === 'en') return en;
  return en === ar ? en : `${en} / ${ar}`;
}

/** The brand as the PDF uses it, from the stored `org_branding` row (none = no brand line). */
export function documentBrand(row: OrgBrandingRow | null): DocumentBrand {
  return {
    name: row?.logoText ?? row?.productName ?? null,
    accent: row?.accentColor ?? null,
  };
}

/** The download name: the kind and the sanitised document number only, never other user text. */
export function documentFileName(kind: 'invoice' | 'quote', number: string | null): string {
  const safe = (number ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|-+$/gu, '');
  return `${kind}-${safe === '' ? 'draft' : safe.slice(0, 64)}.pdf`;
}

function wordsOf(language: DocumentLanguage) {
  return (english: string, arabic: string): string =>
    language === 'en' ? english : language === 'ar' ? arabic : `${english} / ${arabic}`;
}

function partyText(english: string | null, arabic: string | null, language: DocumentLanguage) {
  if (language === 'en') return english ?? arabic ?? '';
  if (language === 'ar') return arabic ?? english ?? '';
  return [english, arabic].filter((part) => part !== null).join('\n');
}

function partySection(
  heading: string,
  party: PrintParty,
  language: DocumentLanguage,
  vatLabel: string,
): PdfSection {
  const w = wordsOf(language);
  return {
    heading,
    rows: [
      { label: w('Name', 'الاسم'), value: partyText(party.nameEn, party.nameAr, language) },
      ...(party.taxRegistrationNo === null
        ? []
        : [{ label: vatLabel, value: party.taxRegistrationNo }]),
      {
        label: w('Address', 'العنوان'),
        value: partyText(party.addressEn, party.addressAr, language),
      },
    ],
  };
}

function lineRow(
  index: number,
  description: string,
  detail: string,
  language: DocumentLanguage,
): PdfRow {
  return {
    label: `${wordsOf(language)('Line', 'بند')} ${String(index + 1)}`,
    value: `${description}\n${detail}`,
  };
}

function subtitleOf(brand: DocumentBrand, parts: readonly string[]): string {
  return [brand.name ?? '', ...parts].filter((part) => part !== '').join('  /  ');
}

function hashRows(hash: string | null): PdfRow[] {
  return hash === null ? [] : [{ label: 'SHA-256', value: hash, mono: true }];
}

/** 52-10 — an invoice (or credit note) as a PDF document. */
export function invoicePdfDocument(
  view: InvoiceView,
  language: DocumentLanguage,
  options: {
    readonly notice: boolean;
    readonly parties: PrintParties;
    readonly country: string | null;
    readonly brand: DocumentBrand;
  },
): PdfDocument {
  const w = wordsOf(language);
  const money = (minor: number) => formatMinor(minor, view.currency);
  const lines = view.lines.map((line, index) =>
    lineRow(
      index,
      documentDescription(line.descriptionEn, line.descriptionAr, language),
      `${String(line.quantity)} ${unitLabel(line.unit, language)} × ${money(line.unitPriceMinor)}` +
        `  ·  ${w('Tax', 'الضريبة')} ${String(line.taxBp / 100)}%  ·  ${money(line.lineGrossMinor)}`,
      language,
    ),
  );
  const totals: PdfRow[] = [
    { label: w('Subtotal', 'المجموع الفرعي'), value: money(view.subtotalMinor) },
    { label: w('Discount', 'الخصم'), value: money(view.discountMinor) },
    ...view.taxByRate.map((rate) => ({
      label: `${w('Tax', 'الضريبة')} ${String(rate.taxBp / 100)}%`,
      value: money(rate.taxMinor),
    })),
    { label: w('Tax', 'الضريبة'), value: money(view.taxMinor) },
    ...(view.depositAppliedMinor === 0
      ? []
      : [
          { label: w('Deposit applied', 'الدفعة المقدمة'), value: money(view.depositAppliedMinor) },
        ]),
    { label: w('Total', 'الإجمالي'), value: money(view.totalMinor) },
    ...(view.paidMinor === 0
      ? []
      : [{ label: w('Paid', 'المدفوع'), value: money(view.paidMinor) }]),
    { label: w('Amount due', 'المبلغ المستحق'), value: money(view.amountDueMinor) },
    {
      label: w('In words', 'كتابةً'),
      value: partyText(view.amountInWords.en, view.amountInWords.ar, language),
    },
  ];
  const number = view.number ?? w('Draft', 'مسودة');
  const vat = w('VAT number', 'الرقم الضريبي');
  return {
    title: `${labelCopy(view.documentLabel, language)} ${number}`,
    subtitle: subtitleOf(options.brand, [
      `${w('Issue date', 'تاريخ الإصدار')}: ${view.issueDate ?? ''}`,
      `${w('Due date', 'تاريخ الاستحقاق')}: ${view.dueDate ?? ''}`,
    ]),
    subject: `${labelCopy(view.documentLabel, 'en')} ${view.number ?? 'draft'}`,
    sections: [
      partySection(w('From', 'من'), options.parties.seller, language, vat),
      partySection(w('Bill to', 'إلى'), options.parties.buyer, language, vat),
      ...(view.poNumber === null && view.contentHash === null
        ? []
        : [
            {
              heading: w('Reference', 'المرجع'),
              rows: [
                ...(view.poNumber === null
                  ? []
                  : [{ label: w('PO number', 'رقم أمر الشراء'), value: view.poNumber }]),
                ...hashRows(view.contentHash),
              ],
            },
          ]),
      { heading: w('Lines', 'البنود'), rows: lines },
      { heading: w('Totals', 'الإجماليات'), rows: totals },
    ],
    notes: [
      ...(options.notice ? [taxNoticeFor(options.country, language)] : []),
      ...(view.terms === null ? [] : [view.terms]),
      ...(view.notes === null ? [] : [view.notes]),
      ...(view.taxRegistrationRef === null
        ? []
        : [
            `${w('Registered reference as entered by the agency', 'المرجع المسجل كما أدخلته الوكالة')}: ${view.taxRegistrationRef}`,
          ]),
    ],
    footer: view.number ?? 'Draft',
    attachments: [],
    ...(options.brand.accent === null ? {} : { accent: options.brand.accent }),
  };
}

/** 52-10 — a quote as a PDF document (never its internal notes). */
export function quotePdfDocument(
  quote: QuotePdfFacts,
  language: DocumentLanguage,
  brand: DocumentBrand,
): PdfDocument {
  const w = wordsOf(language);
  const money = (minor: number) => formatMinor(minor, quote.currency);
  return {
    title: `${w('Quote', 'عرض سعر')} ${quote.number}`,
    subtitle: subtitleOf(brand, [
      quote.title,
      `${w('Valid until', 'صالح حتى')}: ${quote.validUntil.slice(0, 10)}`,
    ]),
    subject: `Quote ${quote.number}`,
    sections: [
      {
        heading: w('Quote', 'عرض السعر'),
        rows: [
          { label: w('Title', 'العنوان'), value: quote.title },
          { label: w('For', 'إلى'), value: quote.recipient ?? '' },
          { label: w('Valid until', 'صالح حتى'), value: quote.validUntil.slice(0, 10) },
          ...hashRows(quote.contentHash),
        ],
      },
      {
        heading: w('Lines', 'البنود'),
        rows: quote.lines.map((line, index) =>
          lineRow(
            index,
            line.description,
            `${String(line.quantity)} ${unitLabel(line.unit, language)} × ${money(line.unitPriceMinor)}` +
              `  ·  ${money(line.lineNetMinor)}  ·  ${w('Tax', 'الضريبة')} ` +
              `${String(line.taxBp / 100)}% ${money(line.lineTaxMinor)}`,
            language,
          ),
        ),
      },
      {
        heading: w('Totals', 'الإجماليات'),
        rows: [
          { label: w('Subtotal', 'المجموع الفرعي'), value: money(quote.subtotalMinor) },
          { label: w('Tax', 'الضريبة'), value: money(quote.taxMinor) },
          { label: w('Total', 'الإجمالي'), value: money(quote.totalMinor) },
        ],
      },
    ],
    notes: quote.terms === null ? [] : [quote.terms],
    footer: quote.number,
    attachments: [],
    ...(brand.accent === null ? {} : { accent: brand.accent }),
  };
}

/** Draw a finance document with the shared writer and name it for the download. */
export async function renderDocumentPdf(
  kind: 'invoice' | 'quote',
  number: string | null,
  document: PdfDocument,
): Promise<RecordPdfFile> {
  const { bytes } = await renderRecordPdf(document);
  return { bytes, fileName: documentFileName(kind, number) };
}
