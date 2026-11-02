/**
 * 52-11 — Wafeq (وافق) import files: Invoices, Credit notes, Payments, Contacts (with TRN) and
 * Expenses. Wafeq asks for an Account on every line; the sales and expense accounts below are the
 * Wafeq default chart's names and are re-mapped on the import screen when the books differ.
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

export const WAFEQ_TEMPLATE_CHECKED_ON = '2026-11-02';

const SALES_ACCOUNT = 'Sales';
const EXPENSE_ACCOUNT = 'General Expenses';

export const WAFEQ: TargetMap = {
  target: 'wafeq',
  label: 'Wafeq',
  dateFormat: 'YYYY-MM-DD',
  decimals: 2,
  taxCodeMap: { S: 'Standard Rate {rate}%', Z: 'Zero Rate', E: 'Exempt', O: 'Out of Scope' },
  templateCheckedOn: WAFEQ_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('wafeq-invoices.csv', [
      req('Invoice No', 'text', (r) => r.invoice.number),
      req('Date', 'date', (r, f) => f.date(r.invoice.issueDate)),
      req('Due Date', 'date', (r, f) => f.date(r.invoice.dueDate ?? r.invoice.issueDate)),
      req('Contact Name', 'text', (r, f) => customerName(f, r.invoice.customerName)),
      opt('Currency', 'text', (r) => r.invoice.currency),
      req('Line Description', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Unit Price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      opt('Discount', 'amount', (r, f) => f.amount(r.line.lineDiscountMinor, r.invoice.currency)),
      req('Tax Rate', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      req('Account', 'text', () => SALES_ACCOUNT),
    ]),
    creditNoteLinesFile('wafeq-credit-notes.csv', [
      req('Credit Note No', 'text', (r) => r.note.number),
      req('Date', 'date', (r, f) => f.date(r.note.issueDate)),
      req('Contact Name', 'text', (r, f) => customerName(f, r.note.customerName)),
      opt('Invoice No', 'text', (r) => r.note.invoiceNumber),
      opt('Currency', 'text', (r) => r.note.currency),
      req('Line Description', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('Unit Price', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      req('Tax Rate', 'tax', (r, f) => f.tax(r.line.taxBp, null)),
      req('Account', 'text', () => SALES_ACCOUNT),
    ]),
    paymentsFile('wafeq-payments.csv', [
      req('Date', 'date', (r, f) => f.date(r.paidOn)),
      req('Contact Name', 'text', (r, f) => customerName(f, r.customerName)),
      req('Invoice No', 'text', (r) => r.invoiceNumber),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Currency', 'text', (r) => r.currency),
      opt('Paid Through', 'text', (r) => r.method),
      opt('Reference', 'text', (r) => r.reference),
    ]),
    customersFile('wafeq-contacts.csv', [
      req('Name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('Arabic Name', 'text', (r, f) => f.arabic(r.legalNameAr)),
      opt('Email', 'text', (r) => r.billingEmail),
      opt('TRN', 'text', (r) => r.taxRegistrationNo),
      opt('Address', 'text', (r, f) => addressOf(r, f)),
      opt('Currency', 'text', (r) => r.defaultCurrency),
    ]),
    expensesFile('wafeq-expenses.csv', [
      req('Date', 'date', (r, f) => f.date(r.spentOn)),
      req('Account', 'text', () => EXPENSE_ACCOUNT),
      opt('Description', 'text', (r, f) => f.text(r.note, null) || r.category),
      req('Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Currency', 'text', (r) => r.currency),
      req('Tax Rate', 'tax', (r, f) => f.tax(r.taxBp, null)),
      opt('Employee', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'Wafeq: use the Import option on each list screen.',
      '- wafeq-contacts.csv: Contacts > Import. Import contacts first.',
      '- wafeq-invoices.csv: Sales > Invoices > Import. Rows with the same Invoice No form one invoice.',
      '- wafeq-credit-notes.csv: Sales > Credit Notes > Import.',
      '- wafeq-payments.csv: Sales > Payments > Import.',
      '- wafeq-expenses.csv: Purchases > Expenses > Import.',
      `Lines use the account "${SALES_ACCOUNT}" (expenses "${EXPENSE_ACCOUNT}"); pick your own accounts on the mapping step if they differ.`,
    ].join('\r\n'),
    ar: [
      'وافق: استخدم خيار الاستيراد في كل شاشة قائمة.',
      '- wafeq-contacts.csv: جهات الاتصال > استيراد. ابدأ بها.',
      '- wafeq-invoices.csv: المبيعات > الفواتير > استيراد. الصفوف ذات رقم الفاتورة نفسه فاتورة واحدة.',
      '- wafeq-credit-notes.csv: المبيعات > الإشعارات الدائنة > استيراد.',
      '- wafeq-payments.csv: المبيعات > المدفوعات > استيراد.',
      '- wafeq-expenses.csv: المشتريات > المصروفات > استيراد.',
      `تستخدم البنود الحساب "${SALES_ACCOUNT}" (والمصروفات "${EXPENSE_ACCOUNT}")؛ اختر حساباتك في خطوة الربط إن اختلفت.`,
    ].join('\r\n'),
  },
};

export const validateWafeq = (files: readonly ExportFile[]): string[] =>
  validateFiles(WAFEQ, files);
