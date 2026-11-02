/**
 * 52-11 — Zoho Books (GCC edition) import files. Column names are the Zoho import templates'
 * verbatim (Invoices, Credit Notes, Customer Payments, Contacts, Expenses); line-level files repeat
 * the invoice header on every line, as Zoho groups by Invoice Number. A template change is a fix in
 * this one file.
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

export const ZOHO_BOOKS_TEMPLATE_CHECKED_ON = '2026-11-02';

export const ZOHO_BOOKS: TargetMap = {
  target: 'zoho_books',
  label: 'Zoho Books',
  dateFormat: 'YYYY-MM-DD',
  decimals: 2,
  taxCodeMap: { S: 'VAT {rate}%', Z: 'Zero Rate', E: 'Exempt', O: 'Out of Scope' },
  templateCheckedOn: ZOHO_BOOKS_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('zoho-invoices.csv', [
      req('Invoice Number', 'text', (r) => r.invoice.number),
      req('Invoice Date', 'date', (r, f) => f.date(r.invoice.issueDate)),
      opt('Due Date', 'date', (r, f) => f.date(r.invoice.dueDate)),
      req('Customer Name', 'text', (r, f) => customerName(f, r.invoice.customerName)),
      opt('Currency Code', 'text', (r) => r.invoice.currency),
      opt('Exchange Rate', 'text', (r) => r.invoice.fxRate ?? '1'),
      req('Item Name', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit).slice(0, 100),
      ),
      opt('Item Desc', 'text', (r, f) => f.text(r.line.descriptionEn, r.line.descriptionAr)),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Item Price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      opt('Item Tax', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      opt('Item Tax %', 'percent', (r, f) => f.percent(r.line.taxBp)),
      opt('Discount', 'amount', (r, f) => f.amount(r.line.lineDiscountMinor, r.invoice.currency)),
      opt('Notes', 'text', (r, f) => f.text(r.invoice.notes, null)),
      opt('Terms & Conditions', 'text', (r, f) => f.text(r.invoice.terms, null)),
    ]),
    creditNoteLinesFile('zoho-credit-notes.csv', [
      req('Credit Note Number', 'text', (r) => r.note.number),
      req('Credit Note Date', 'date', (r, f) => f.date(r.note.issueDate)),
      req('Customer Name', 'text', (r, f) => customerName(f, r.note.customerName)),
      opt('Currency Code', 'text', (r) => r.note.currency),
      opt('Reference#', 'text', (r) => r.note.invoiceNumber),
      opt('Reason', 'text', (r, f) => f.text(r.note.reason, null)),
      req('Item Name', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit).slice(0, 100),
      ),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Item Price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      opt('Item Tax %', 'percent', (r, f) => f.percent(r.line.taxBp)),
    ]),
    paymentsFile('zoho-customer-payments.csv', [
      req('Date', 'date', (r, f) => f.date(r.paidOn)),
      req('Customer Name', 'text', (r, f) => customerName(f, r.customerName)),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Payment Mode', 'text', (r) => r.method),
      opt('Reference Number', 'text', (r) => r.reference),
      req('Invoice Number', 'text', (r) => r.invoiceNumber),
      req('Amount Applied to Invoice', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Currency Code', 'text', (r) => r.currency),
    ]),
    customersFile('zoho-contacts.csv', [
      req('Display Name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('Company Name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('Email ID', 'text', (r) => r.billingEmail),
      opt('Billing Address', 'text', (r, f) => addressOf(r, f)),
      opt('Currency Code', 'text', (r) => r.defaultCurrency),
      opt('VAT Treatment', 'text', (r) =>
        r.taxRegistrationNo ? 'vat_registered' : 'vat_not_registered',
      ),
      opt('Tax Registration Number', 'text', (r) => r.taxRegistrationNo),
      opt('Place of Supply', 'text', () => ''),
    ]),
    expensesFile('zoho-expenses.csv', [
      req('Expense Date', 'date', (r, f) => f.date(r.spentOn)),
      req('Expense Account', 'text', (r) => r.category),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Currency Code', 'text', (r) => r.currency),
      opt('Tax %', 'percent', (r, f) => f.percent(r.taxBp)),
      opt('Is Billable', 'text', (r) => (r.billable ? 'TRUE' : 'FALSE')),
      opt('Description', 'text', (r, f) => f.text(r.note, null)),
      opt('Employee Name', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'Zoho Books: import each file from its own module.',
      '- zoho-contacts.csv: Sales > Customers > (menu) Import Customers. Import contacts first.',
      '- zoho-invoices.csv: Sales > Invoices > (menu) Import Invoices. Rows with the same Invoice Number form one invoice.',
      '- zoho-credit-notes.csv: Sales > Credit Notes > Import Credit Notes.',
      '- zoho-customer-payments.csv: Sales > Payments Received > Import Payments.',
      '- zoho-expenses.csv: Purchases > Expenses > Import Expenses. Map "Expense Account" to your chart of accounts.',
      'Choose the date format yyyy-MM-dd and the character encoding UTF-8 on the import screen.',
    ].join('\r\n'),
    ar: [
      'Zoho Books: استورد كل ملف من الوحدة الخاصة به.',
      '- zoho-contacts.csv: المبيعات > العملاء > استيراد العملاء. ابدأ بالعملاء.',
      '- zoho-invoices.csv: المبيعات > الفواتير > استيراد الفواتير. الصفوف ذات رقم الفاتورة نفسه فاتورة واحدة.',
      '- zoho-credit-notes.csv: المبيعات > الإشعارات الدائنة > استيراد.',
      '- zoho-customer-payments.csv: المبيعات > المدفوعات المستلمة > استيراد المدفوعات.',
      '- zoho-expenses.csv: المشتريات > المصروفات > استيراد المصروفات. اربط "Expense Account" بدليل حساباتك.',
      'اختر تنسيق التاريخ yyyy-MM-dd وترميز UTF-8 في شاشة الاستيراد.',
    ].join('\r\n'),
  },
};

export const validateZohoBooks = (files: readonly ExportFile[]): string[] =>
  validateFiles(ZOHO_BOOKS, files);
