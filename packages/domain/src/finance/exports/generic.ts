/**
 * 52-11 — the generic target: TManage's own documented CSV, one file per entity, ISO dates, the
 * UBL tax categories (S/Z/E/O), English and Arabic descriptions in separate columns. UBL 2.1 XML
 * (52-12) is not part of this target yet; the README says so.
 */

import {
  creditNoteLinesFile,
  customersFile,
  expensesFile,
  invoiceLinesFile,
  opt,
  paymentsFile,
  req,
  validateFiles,
} from './columns.js';
import type { ExportFile, TargetMap } from './types.js';

export const GENERIC_TEMPLATE_CHECKED_ON = '2026-11-02';

export const GENERIC: TargetMap = {
  target: 'generic',
  label: 'Generic CSV',
  dateFormat: 'YYYY-MM-DD',
  decimals: 2,
  taxCodeMap: { S: 'S', Z: 'Z', E: 'E', O: 'O' },
  templateCheckedOn: GENERIC_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('invoices.csv', [
      req('invoice_id', 'text', (r) => r.invoice.id),
      req('invoice_number', 'text', (r) => r.invoice.number),
      req('invoice_kind', 'text', (r) => r.invoice.kind),
      req('state', 'text', (r) => r.invoice.state),
      req('issue_date', 'date', (r, f) => f.date(r.invoice.issueDate)),
      opt('due_date', 'date', (r, f) => f.date(r.invoice.dueDate)),
      opt('supply_date', 'date', (r, f) => f.date(r.invoice.supplyDate)),
      req('customer_id', 'text', (r) => r.invoice.customerId),
      req('customer_name', 'text', (r) => r.invoice.customerName),
      opt('customer_name_ar', 'text', (r, f) => f.arabic(r.invoice.customerNameAr)),
      req('currency', 'text', (r) => r.invoice.currency),
      opt('fx_rate', 'text', (r) => r.invoice.fxRate),
      opt('po_number', 'text', (r) => r.invoice.poNumber),
      req('line_position', 'text', (r) => r.line.position),
      opt('description_en', 'text', (r, f) => f.text(r.line.descriptionEn, null)),
      opt('description_ar', 'text', (r, f) => f.arabic(r.line.descriptionAr)),
      req('quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('unit', 'text', (r) => r.line.unit),
      req('unit_price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      req('line_discount', 'amount', (r, f) =>
        f.amount(r.line.lineDiscountMinor, r.invoice.currency),
      ),
      req('line_net', 'amount', (r, f) => f.amount(r.line.lineNetMinor, r.invoice.currency)),
      req('tax_category', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      req('tax_rate', 'percent', (r, f) => f.percent(r.line.taxBp)),
      req('line_tax', 'amount', (r, f) => f.amount(r.line.lineTaxMinor, r.invoice.currency)),
      req('line_gross', 'amount', (r, f) => f.amount(r.line.lineGrossMinor, r.invoice.currency)),
      req('invoice_subtotal', 'amount', (r, f) =>
        f.amount(r.invoice.subtotalMinor, r.invoice.currency),
      ),
      req('invoice_tax', 'amount', (r, f) => f.amount(r.invoice.taxMinor, r.invoice.currency)),
      req('invoice_total', 'amount', (r, f) => f.amount(r.invoice.totalMinor, r.invoice.currency)),
    ]),
    creditNoteLinesFile('credit_notes.csv', [
      req('credit_note_id', 'text', (r) => r.note.id),
      req('credit_note_number', 'text', (r) => r.note.number),
      req('invoice_id', 'text', (r) => r.note.invoiceId),
      opt('invoice_number', 'text', (r) => r.note.invoiceNumber),
      req('issue_date', 'date', (r, f) => f.date(r.note.issueDate)),
      req('customer_id', 'text', (r) => r.note.customerId),
      req('customer_name', 'text', (r) => r.note.customerName),
      req('currency', 'text', (r) => r.note.currency),
      opt('reason', 'text', (r, f) => f.text(r.note.reason, null)),
      req('line_position', 'text', (r) => r.line.position),
      opt('description_en', 'text', (r, f) => f.text(r.line.descriptionEn, null)),
      opt('description_ar', 'text', (r, f) => f.arabic(r.line.descriptionAr)),
      req('quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('unit_price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      req('line_net', 'amount', (r, f) => f.amount(r.line.lineNetMinor, r.note.currency)),
      req('tax_rate', 'percent', (r, f) => f.percent(r.line.taxBp)),
      req('line_tax', 'amount', (r, f) => f.amount(r.line.lineTaxMinor, r.note.currency)),
      req('line_gross', 'amount', (r, f) => f.amount(r.line.lineGrossMinor, r.note.currency)),
      req('credit_note_total', 'amount', (r, f) => f.amount(r.note.totalMinor, r.note.currency)),
    ]),
    paymentsFile('payments.csv', [
      req('payment_id', 'text', (r) => r.id),
      req('invoice_id', 'text', (r) => r.invoiceId),
      opt('invoice_number', 'text', (r) => r.invoiceNumber),
      req('customer_id', 'text', (r) => r.customerId),
      req('customer_name', 'text', (r) => r.customerName),
      req('paid_on', 'date', (r, f) => f.date(r.paidOn)),
      req('amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('currency', 'text', (r) => r.currency),
      req('method', 'text', (r) => r.method),
      opt('reference', 'text', (r) => r.reference),
    ]),
    customersFile('customers.csv', [
      req('customer_id', 'text', (r) => r.id),
      req('name', 'text', (r) => r.name),
      opt('legal_name_en', 'text', (r) => r.legalNameEn),
      opt('legal_name_ar', 'text', (r, f) => f.arabic(r.legalNameAr)),
      opt('tax_registration_no', 'text', (r) => r.taxRegistrationNo),
      opt('billing_address_en', 'text', (r) => r.billingAddressEn),
      opt('billing_address_ar', 'text', (r, f) => f.arabic(r.billingAddressAr)),
      opt('billing_email', 'text', (r) => r.billingEmail),
      opt('default_currency', 'text', (r) => r.defaultCurrency),
    ]),
    expensesFile('expenses.csv', [
      req('expense_id', 'text', (r) => r.id),
      req('spent_on', 'date', (r, f) => f.date(r.spentOn)),
      req('category', 'text', (r) => r.category),
      req('amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('currency', 'text', (r) => r.currency),
      req('tax_rate', 'percent', (r, f) => f.percent(r.taxBp)),
      req('billable', 'text', (r) => (r.billable ? 'true' : 'false')),
      req('markup_rate', 'percent', (r, f) => f.percent(r.markupBp)),
      opt('note', 'text', (r, f) => f.text(r.note, null)),
      opt('submitter_name', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'Generic CSV: one file per entity, for any system or a spreadsheet.',
      '- invoices.csv / credit_notes.csv: one row per line; the invoice columns repeat on each line.',
      '- payments.csv, customers.csv, expenses.csv: one row per record.',
      'Dates are YYYY-MM-DD, amounts carry 2 decimals (3 for KWD, BHD, OMR, JOD, TND, IQD), tax_category is the UBL code (S standard, Z zero-rated, E exempt, O out of scope).',
      'UBL 2.1 XML is not included in this export yet.',
    ].join('\r\n'),
    ar: [
      'CSV عام: ملف لكل كيان، لأي نظام أو جدول بيانات.',
      '- invoices.csv / credit_notes.csv: صف لكل بند؛ أعمدة الفاتورة تتكرر في كل بند.',
      '- payments.csv و customers.csv و expenses.csv: صف لكل سجل.',
      'التواريخ YYYY-MM-DD، والمبالغ بخانتين عشريتين (ثلاث للدينار الكويتي والبحريني والريال العماني ...)، و tax_category هو رمز UBL (S قياسي، Z صفري، E معفى، O خارج النطاق).',
      'لا يتضمن هذا التصدير ملفات UBL 2.1 XML بعد.',
    ].join('\r\n'),
  },
};

export const validateGeneric = (files: readonly ExportFile[]): string[] =>
  validateFiles(GENERIC, files);
