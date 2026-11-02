/**
 * 52-11 — Xero import files. The invoice header is Xero's "Sales invoices" CSV template verbatim
 * (`*` marks the required columns); credit notes use Xero's credit-note template, contacts its
 * contacts template. Xero imports no customer payments or expense claims by CSV, so those two files
 * are written in the same style for the bank-statement import / manual entry, as the README says.
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

export const XERO_TEMPLATE_CHECKED_ON = '2026-11-02';

/** Xero's default chart: 200 Sales, 429 General Expenses. */
const SALES_ACCOUNT = '200';
const EXPENSE_ACCOUNT = '429';

export const XERO: TargetMap = {
  target: 'xero',
  label: 'Xero',
  dateFormat: 'DD/MM/YYYY',
  decimals: 2,
  taxCodeMap: { S: 'OUTPUT', Z: 'ZERORATEDOUTPUT', E: 'EXEMPTOUTPUT', O: 'NONE' },
  templateCheckedOn: XERO_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile('xero-sales-invoices.csv', [
      req('*ContactName', 'text', (r, f) => customerName(f, r.invoice.customerName)),
      opt('EmailAddress', 'text', (r) => r.invoice.customerEmail),
      opt('POAddressLine1', 'text', (r, f) => f.text(r.invoice.customerAddress, null)),
      req('*InvoiceNumber', 'text', (r) => r.invoice.number),
      opt('Reference', 'text', (r) => r.invoice.poNumber),
      req('*InvoiceDate', 'date', (r, f) => f.date(r.invoice.issueDate)),
      req('*DueDate', 'date', (r, f) => f.date(r.invoice.dueDate ?? r.invoice.issueDate)),
      opt('Total', 'amount', (r, f) => f.amount(r.invoice.totalMinor, r.invoice.currency)),
      opt('InventoryItemCode', 'text', () => ''),
      req('*Description', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('*Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('*UnitAmount', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.invoice.currency)),
      opt('Discount', 'percent', (r, f) => f.percent(r.line.discountBp)),
      req('*AccountCode', 'text', () => SALES_ACCOUNT),
      req('*TaxType', 'tax', (r, f) => f.tax(r.line.taxBp, r.line.taxCategory)),
      opt('TaxAmount', 'amount', (r, f) => f.amount(r.line.lineTaxMinor, r.invoice.currency)),
      opt('TrackingName1', 'text', () => ''),
      opt('TrackingOption1', 'text', () => ''),
      opt('Currency', 'text', (r) => r.invoice.currency),
    ]),
    creditNoteLinesFile('xero-credit-notes.csv', [
      req('*ContactName', 'text', (r, f) => customerName(f, r.note.customerName)),
      req('*CreditNoteNumber', 'text', (r) => r.note.number),
      opt('Reference', 'text', (r) => r.note.invoiceNumber),
      req('*Date', 'date', (r, f) => f.date(r.note.issueDate)),
      req('*Description', 'text', (r, f) =>
        describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
      ),
      req('*Quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
      req('*UnitAmount', 'amount', (r, f) => f.amount(r.line.unitPriceMinor, r.note.currency)),
      req('*AccountCode', 'text', () => SALES_ACCOUNT),
      req('*TaxType', 'tax', (r, f) => f.tax(r.line.taxBp, null)),
      opt('Currency', 'text', (r) => r.note.currency),
    ]),
    paymentsFile('xero-payments.csv', [
      req('*Date', 'date', (r, f) => f.date(r.paidOn)),
      req('*InvoiceNumber', 'text', (r) => r.invoiceNumber),
      req('*Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      opt('ContactName', 'text', (r, f) => customerName(f, r.customerName)),
      opt('Reference', 'text', (r) => r.reference),
      opt('Currency', 'text', (r) => r.currency),
    ]),
    customersFile('xero-contacts.csv', [
      req('*ContactName', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      opt('EmailAddress', 'text', (r) => r.billingEmail),
      opt('POAddressLine1', 'text', (r, f) => addressOf(r, f)),
      opt('TaxNumber', 'text', (r) => r.taxRegistrationNo),
      opt('DefaultCurrency', 'text', (r) => r.defaultCurrency),
    ]),
    expensesFile('xero-expenses.csv', [
      req('*Date', 'date', (r, f) => f.date(r.spentOn)),
      req('*Description', 'text', (r, f) => f.text(r.note, null) || r.category),
      req('*Amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('*AccountCode', 'text', () => EXPENSE_ACCOUNT),
      req('*TaxType', 'tax', (r, f) => f.tax(r.taxBp, null)),
      opt('Currency', 'text', (r) => r.currency),
      opt('Employee', 'text', (r) => r.submitterName),
    ]),
  ],
  readme: {
    en: [
      'Xero: each import starts from its own list.',
      '- xero-contacts.csv: Contacts > All contacts > Import. Import contacts first.',
      '- xero-sales-invoices.csv: Business > Invoices > Import. Rows with the same *InvoiceNumber form one invoice.',
      '- xero-credit-notes.csv: Business > Invoices > Import (choose credit notes).',
      '- xero-payments.csv: Xero has no payment CSV import; apply these with "Add payment" on each invoice or match them in bank reconciliation.',
      '- xero-expenses.csv: no expense-claim CSV import; use it to enter spend money / bills.',
      `Accounts: sales ${SALES_ACCOUNT}, expenses ${EXPENSE_ACCOUNT} (Xero default chart). Tax types are Xero's codes (OUTPUT, ZERORATEDOUTPUT, EXEMPTOUTPUT, NONE). Dates are DD/MM/YYYY.`,
    ].join('\r\n'),
    ar: [
      'Xero: يبدأ كل استيراد من قائمته.',
      '- xero-contacts.csv: جهات الاتصال > كل جهات الاتصال > استيراد. ابدأ بها.',
      '- xero-sales-invoices.csv: الأعمال > الفواتير > استيراد. الصفوف ذات *InvoiceNumber نفسه فاتورة واحدة.',
      '- xero-credit-notes.csv: الأعمال > الفواتير > استيراد (اختر الإشعارات الدائنة).',
      '- xero-payments.csv: لا يستورد Xero المدفوعات من CSV؛ سجّلها بـ "Add payment" على كل فاتورة أو طابقها في التسوية البنكية.',
      '- xero-expenses.csv: لا يوجد استيراد CSV لمطالبات المصروفات؛ استخدمه لإدخال المصروفات أو الفواتير الواردة.',
      `الحسابات: المبيعات ${SALES_ACCOUNT}، المصروفات ${EXPENSE_ACCOUNT} (الدليل الافتراضي في Xero). أنواع الضريبة بأكواد Xero. التواريخ بصيغة يوم/شهر/سنة.`,
    ].join('\r\n'),
  },
};

export const validateXero = (files: readonly ExportFile[]): string[] => validateFiles(XERO, files);
