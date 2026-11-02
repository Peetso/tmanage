/**
 * 52-11 — Qoyod (قيود) import files. Qoyod's import sheets accept English or Arabic headers; the
 * English ones are written here (Invoice number, Customer, Issue date, …). The sheets are opened
 * in Excel and saved as .xlsx when the Qoyod screen asks for Excel — the columns are unchanged.
 */

import {
  addressOf,
  creditNoteLinesFile,
  customerName,
  customersFile,
  describe,
  expensesFile,
  invoiceLinesFile,
  opt,
  paymentsFile,
  req,
  validateFiles,
} from './columns.js';
import type { ExportFile, TargetMap } from './types.js';

export const QOYOD_TEMPLATE_CHECKED_ON = '2026-11-02';

export const QOYOD: TargetMap = {
  target: 'qoyod',
  label: 'Qoyod',
  dateFormat: 'DD/MM/YYYY',
  decimals: 2,
  taxCodeMap: { S: 'VAT {rate}%', Z: 'Zero rated', E: 'Exempt', O: 'Not subject to VAT' },
  templateCheckedOn: QOYOD_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('qoyod-invoices.csv', [
      req('Invoice number', 'text', (r) => r.invoice.number),
      req('Customer', 'text', (r, f) => customerName(f, r.invoice.customerName)),
      req('Issue date', 'date', (r, f) => f.date(r.invoice.issueDate)),
      req('Due date', 'date', (r, f) => f.date(r.invoice.dueDate ?? r.invoice.issueDate)),
      req('Product/service', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Unit price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      req('Tax', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      opt('Discount', 'amount', (r, f) => f.amount(r.line.lineDiscountMinor, r.invoice.currency)),
      opt('Currency', 'text', (r) => r.invoice.currency),
    ]),
    creditNoteLinesFile('qoyod-credit-notes.csv', [
      req('Credit note number', 'text', (r) => r.note.number),
      opt('Invoice number', 'text', (r) => r.note.invoiceNumber),
      req('Customer', 'text', (r, f) => customerName(f, r.note.customerName)),
      req('Issue date', 'date', (r, f) => f.date(r.note.issueDate)),
      req('Product/service', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Unit price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      req('Tax', 'tax', (r, f) => f.tax(r.line.taxBp, null)),
    ]),
    paymentsFile('qoyod-receipts.csv', [
      req('Receipt date', 'date', (r, f) => f.date(r.paidOn)),
      req('Customer', 'text', (r, f) => customerName(f, r.customerName)),
      req('Invoice number', 'text', (r) => r.invoiceNumber),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Payment method', 'text', (r) => r.method),
      opt('Reference', 'text', (r) => r.reference),
    ]),
    customersFile('qoyod-customers.csv', [
      req('Name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('Arabic name', 'text', (r, f) => f.arabic(r.legalNameAr)),
      opt('Email', 'text', (r) => r.billingEmail),
      opt('VAT number', 'text', (r) => r.taxRegistrationNo),
      opt('Address', 'text', (r, f) => addressOf(r, f)),
      opt('Currency', 'text', (r) => r.defaultCurrency),
    ]),
    expensesFile('qoyod-expenses.csv', [
      req('Date', 'date', (r, f) => f.date(r.spentOn)),
      req('Account', 'text', (r) => r.category),
      opt('Description', 'text', (r, f) => f.text(r.note, null)),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('Tax', 'tax', (r, f) => f.tax(r.taxBp, null)),
      opt('Employee', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'Qoyod: each sheet is imported from its own list screen with the Import button.',
      '- qoyod-customers.csv: Sales > Customers > Import. Import customers first.',
      '- qoyod-invoices.csv: Sales > Invoices > Import. Rows with the same Invoice number form one invoice.',
      '- qoyod-credit-notes.csv: Sales > Credit notes > Import.',
      '- qoyod-receipts.csv: Sales > Receipts > Import.',
      '- qoyod-expenses.csv: Purchases > Expenses > Import. Map "Account" to your chart of accounts.',
      'If Qoyod asks for an Excel file, open the CSV in Excel and save it as .xlsx. Dates are DD/MM/YYYY.',
    ].join('\r\n'),
    ar: [
      'قيود: يُستورد كل ملف من شاشة القائمة الخاصة به بزر الاستيراد.',
      '- qoyod-customers.csv: المبيعات > العملاء > استيراد. ابدأ بالعملاء.',
      '- qoyod-invoices.csv: المبيعات > الفواتير > استيراد. الصفوف ذات رقم الفاتورة نفسه فاتورة واحدة.',
      '- qoyod-credit-notes.csv: المبيعات > الإشعارات الدائنة > استيراد.',
      '- qoyod-receipts.csv: المبيعات > سندات القبض > استيراد.',
      '- qoyod-expenses.csv: المشتريات > المصروفات > استيراد. اربط "Account" بدليل حساباتك.',
      'إذا طلب قيود ملف Excel فافتح الملف في Excel واحفظه بصيغة .xlsx. التواريخ بصيغة يوم/شهر/سنة.',
    ].join('\r\n'),
  },
};

export const validateQoyod = (files: readonly ExportFile[]): string[] =>
  validateFiles(QOYOD, files);
