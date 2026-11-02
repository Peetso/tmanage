/**
 * 52-11 — QuickBooks Online import files. The invoice header is QBO's "Import invoices" template
 * verbatim (`*` marks the columns QBO requires); credit memos, payments, customers and expenses
 * follow the same naming. QBO reads dates in the company's date format; the export writes
 * MM/DD/YYYY, QBO's default, and the README says to switch the import screen when the company
 * uses another.
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

export const QUICKBOOKS_TEMPLATE_CHECKED_ON = '2026-11-02';

const PRODUCT = 'Services';

export const QUICKBOOKS: TargetMap = {
  target: 'quickbooks',
  label: 'QuickBooks Online',
  dateFormat: 'MM/DD/YYYY',
  decimals: 2,
  taxCodeMap: { S: 'VAT {rate}%', Z: 'Zero-rated', E: 'Exempt', O: 'Out of scope' },
  templateCheckedOn: QUICKBOOKS_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('quickbooks-invoices.csv', [
      req('*InvoiceNo', 'text', (r) => r.invoice.number),
      req('*Customer', 'text', (r, f) => customerName(f, r.invoice.customerName)),
      req('*InvoiceDate', 'date', (r, f) => f.date(r.invoice.issueDate)),
      req('*DueDate', 'date', (r, f) => f.date(r.invoice.dueDate ?? r.invoice.issueDate)),
      opt('Terms', 'text', () => ''),
      opt('Location', 'text', () => ''),
      opt('Memo', 'text', (r, f) => f.text(r.invoice.notes, null)),
      req('*Item(Product/Service)', 'text', () => PRODUCT),
      opt('ItemDescription', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      opt('ItemQuantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      opt('ItemRate', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      req('*ItemAmount', 'amount', (r, f) => f.amount(r.line.lineNetMinor, r.invoice.currency)),
      opt('Taxable', 'text', (r) => (r.line.taxBp > 0 ? 'Y' : 'N')),
      opt('TaxRate', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      opt('Currency', 'text', (r) => r.invoice.currency),
      opt('ServiceDate', 'date', (r, f) => f.date(r.invoice.supplyDate)),
    ]),
    creditNoteLinesFile('quickbooks-credit-memos.csv', [
      req('*CreditMemoNo', 'text', (r) => r.note.number),
      req('*Customer', 'text', (r, f) => customerName(f, r.note.customerName)),
      req('*CreditMemoDate', 'date', (r, f) => f.date(r.note.issueDate)),
      opt('Memo', 'text', (r, f) =>
        f.text([r.note.invoiceNumber, r.note.reason].filter(Boolean).join(' '), null),
      ),
      req('*Item(Product/Service)', 'text', () => PRODUCT),
      opt('ItemDescription', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      opt('ItemQuantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      opt('ItemRate', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      req('*ItemAmount', 'amount', (r, f) => f.amount(r.line.lineNetMinor, r.note.currency)),
      opt('Taxable', 'text', (r) => (r.line.taxBp > 0 ? 'Y' : 'N')),
      opt('TaxRate', 'tax', (r, f) => f.tax(r.line.taxBp, null)),
      opt('Currency', 'text', (r) => r.note.currency),
    ]),
    paymentsFile('quickbooks-payments.csv', [
      req('*PaymentDate', 'date', (r, f) => f.date(r.paidOn)),
      req('*Customer', 'text', (r, f) => customerName(f, r.customerName)),
      req('*InvoiceNo', 'text', (r) => r.invoiceNumber),
      req('*Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('PaymentMethod', 'text', (r) => r.method),
      opt('ReferenceNo', 'text', (r) => r.reference),
      opt('Currency', 'text', (r) => r.currency),
    ]),
    customersFile('quickbooks-customers.csv', [
      req('*Name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('CompanyName', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('Email', 'text', (r) => r.billingEmail),
      opt('BillingAddress', 'text', (r, f) => addressOf(r, f)),
      opt('TaxRegistrationNumber', 'text', (r) => r.taxRegistrationNo),
      opt('Currency', 'text', (r) => r.defaultCurrency),
    ]),
    expensesFile('quickbooks-expenses.csv', [
      req('*ExpenseDate', 'date', (r, f) => f.date(r.spentOn)),
      req('*Account', 'text', (r) => r.category),
      opt('Description', 'text', (r, f) => f.text(r.note, null)),
      req('*Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('Currency', 'text', (r) => r.currency),
      opt('TaxRate', 'tax', (r, f) => f.tax(r.taxBp, null)),
      opt('Payee', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'QuickBooks Online: Settings (gear) > Import data, then pick the data type of each file.',
      '- quickbooks-customers.csv: Customers. Import customers first.',
      '- quickbooks-invoices.csv: Invoices. Rows with the same *InvoiceNo form one invoice.',
      '- quickbooks-credit-memos.csv: import as Credit memos (or enter them from the list if your region lacks that import).',
      '- quickbooks-payments.csv: record against the invoices (Bank transactions import, or Receive payment).',
      '- quickbooks-expenses.csv: Bank transactions / Expenses. Map "*Account" to your chart of accounts.',
      `Dates are MM/DD/YYYY; change the date format on the import screen if your company uses another. Lines use the product "${PRODUCT}".`,
    ].join('\r\n'),
    ar: [
      'QuickBooks Online: الإعدادات (الترس) > استيراد البيانات، ثم اختر نوع البيانات لكل ملف.',
      '- quickbooks-customers.csv: العملاء. ابدأ بهم.',
      '- quickbooks-invoices.csv: الفواتير. الصفوف ذات *InvoiceNo نفسه فاتورة واحدة.',
      '- quickbooks-credit-memos.csv: الإشعارات الدائنة (أو أدخلها يدوياً إن لم يتوفر الاستيراد في منطقتك).',
      '- quickbooks-payments.csv: سجّلها على الفواتير (استيراد المعاملات البنكية أو استلام دفعة).',
      '- quickbooks-expenses.csv: المصروفات. اربط "*Account" بدليل حساباتك.',
      `التواريخ بصيغة شهر/يوم/سنة؛ غيّرها في شاشة الاستيراد إن كانت شركتك تستخدم صيغة أخرى. البنود تستخدم المنتج "${PRODUCT}".`,
    ].join('\r\n'),
  },
};

export const validateQuickbooks = (files: readonly ExportFile[]): string[] =>
  validateFiles(QUICKBOOKS, files);
