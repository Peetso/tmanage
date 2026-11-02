/**
 * 52-11 — Odoo import files (Accounting app, the standard list-view "Import records" screen).
 * Field paths are Odoo's own (`account.move`, `account.payment`, `res.partner`, `hr.expense`).
 * Every record carries an external id `__export__.tmanage_<id>` so a re-import updates instead of
 * duplicating; a multi-line move follows Odoo's import convention — the first row of a move carries
 * the move's fields, the following rows only the `invoice_line_ids/*` columns.
 */

import {
  addressOf,
  creditNoteLinesFile,
  customerName,
  customersFile,
  describe,
  doc,
  expensesFile,
  invoiceLinesFile,
  opt,
  paymentsFile,
  req,
  validateFiles,
} from './columns.js';
import type { ExportFile, TargetMap } from './types.js';

export const ODOO_TEMPLATE_CHECKED_ON = '2026-11-02';

/** The external id Odoo keeps for a record imported from TManage. */
export const odooExternalId = (kind: string, id: string): string =>
  `__export__.tmanage_${kind}_${id.replace(/-/gu, '')}`;

export const ODOO: TargetMap = {
  target: 'odoo',
  label: 'Odoo',
  dateFormat: 'YYYY-MM-DD',
  decimals: 2,
  taxCodeMap: { S: '{rate}%', Z: '0% Zero Rated', E: '0% Exempt', O: '0% Out of Scope' },
  templateCheckedOn: ODOO_TEMPLATE_CHECKED_ON,
  files: [
    invoiceLinesFile(
      'odoo-account.move-invoices.csv',
      [
        doc(req('id', 'text', (r) => odooExternalId('invoice', r.invoice.id))),
        doc(req('move_type', 'text', () => 'out_invoice')),
        doc(req('name', 'text', (r) => r.invoice.number)),
        doc(req('partner_id/name', 'text', (r, f) => customerName(f, r.invoice.customerName))),
        doc(req('invoice_date', 'date', (r, f) => f.date(r.invoice.issueDate))),
        doc(opt('invoice_date_due', 'date', (r, f) => f.date(r.invoice.dueDate))),
        doc(req('currency_id/name', 'text', (r) => r.invoice.currency)),
        doc(opt('ref', 'text', (r) => r.invoice.poNumber)),
        req('invoice_line_ids/name', 'text', (r, f) =>
          describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
        ),
        req('invoice_line_ids/quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
        req('invoice_line_ids/price_unit', 'amount', (r, f) =>
          f.amount(r.line.unitPriceMinor, r.invoice.currency),
        ),
        opt('invoice_line_ids/discount', 'percent', (r, f) => f.percent(r.line.discountBp)),
        req('invoice_line_ids/tax_ids/name', 'tax', (r, f) =>
          f.tax(r.line.taxBp, r.line.taxCategory),
        ),
      ],
      true,
    ),
    creditNoteLinesFile(
      'odoo-account.move-credit-notes.csv',
      [
        doc(req('id', 'text', (r) => odooExternalId('credit_note', r.note.id))),
        doc(req('move_type', 'text', () => 'out_refund')),
        doc(req('name', 'text', (r) => r.note.number)),
        doc(req('partner_id/name', 'text', (r, f) => customerName(f, r.note.customerName))),
        doc(req('invoice_date', 'date', (r, f) => f.date(r.note.issueDate))),
        doc(req('currency_id/name', 'text', (r) => r.note.currency)),
        doc(opt('ref', 'text', (r) => r.note.invoiceNumber)),
        req('invoice_line_ids/name', 'text', (r, f) =>
          describe(f, r.line.descriptionEn, r.line.descriptionAr, r.line.unit),
        ),
        req('invoice_line_ids/quantity', 'quantity', (r, f) => f.quantity(r.line.quantityCenti)),
        req('invoice_line_ids/price_unit', 'amount', (r, f) =>
          f.amount(r.line.unitPriceMinor, r.note.currency),
        ),
        req('invoice_line_ids/tax_ids/name', 'tax', (r, f) => f.tax(r.line.taxBp, null)),
      ],
      true,
    ),
    paymentsFile('odoo-account.payment.csv', [
      req('id', 'text', (r) => odooExternalId('payment', r.id)),
      req('payment_type', 'text', () => 'inbound'),
      req('partner_type', 'text', () => 'customer'),
      req('partner_id/name', 'text', (r, f) => customerName(f, r.customerName)),
      req('amount', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('currency_id/name', 'text', (r) => r.currency),
      req('date', 'date', (r, f) => f.date(r.paidOn)),
      opt('ref', 'text', (r) => [r.invoiceNumber, r.reference].filter(Boolean).join(' ')),
    ]),
    customersFile('odoo-res.partner.csv', [
      req('id', 'text', (r) => odooExternalId('customer', r.id)),
      req('name', 'text', (r, f) => customerName(f, r.legalNameEn ?? r.name)),
      req('is_company', 'text', () => '1'),
      opt('vat', 'text', (r) => r.taxRegistrationNo),
      opt('street', 'text', (r, f) => addressOf(r, f)),
      opt('email', 'text', (r) => r.billingEmail),
    ]),
    expensesFile('odoo-hr.expense.csv', [
      req('id', 'text', (r) => odooExternalId('expense', r.id)),
      req('name', 'text', (r, f) => f.text(r.note, null) || r.category),
      req('date', 'date', (r, f) => f.date(r.spentOn)),
      opt('employee_id/name', 'text', (r) => r.submitterName),
      req('product_id/name', 'text', (r) => r.category),
      req('total_amount_currency', 'amount', (r, f) => f.amount(r.amountMinor, r.currency)),
      req('currency_id/name', 'text', (r) => r.currency),
    ]),
  ],
  readme: {
    en: [
      'Odoo: open the list view named in each file and use Favorites (star) > Import records.',
      '- odoo-res.partner.csv: Contacts. Import contacts first.',
      '- odoo-account.move-invoices.csv: Accounting > Customers > Invoices.',
      '- odoo-account.move-credit-notes.csv: Accounting > Customers > Credit Notes.',
      '- odoo-account.payment.csv: Accounting > Customers > Payments.',
      '- odoo-hr.expense.csv: Expenses > My Expenses (create the expense products first).',
      'Tick "Use first row as header"; encoding UTF-8; separator comma; date format %Y-%m-%d.',
      'Tax names must match your Odoo sales taxes (for example "15%"); rename them on the import screen if they differ.',
      'External ids (__export__.tmanage_...) make a second import update the same records.',
    ].join('\r\n'),
    ar: [
      'Odoo: افتح قائمة السجلات المذكورة لكل ملف واختر المفضلة > استيراد السجلات.',
      '- odoo-res.partner.csv: جهات الاتصال. ابدأ بها.',
      '- odoo-account.move-invoices.csv: المحاسبة > العملاء > الفواتير.',
      '- odoo-account.move-credit-notes.csv: المحاسبة > العملاء > الإشعارات الدائنة.',
      '- odoo-account.payment.csv: المحاسبة > العملاء > المدفوعات.',
      '- odoo-hr.expense.csv: المصروفات (أنشئ منتجات المصروفات أولاً).',
      'فعّل "استخدام الصف الأول كعناوين"؛ الترميز UTF-8؛ الفاصل فاصلة؛ تنسيق التاريخ %Y-%m-%d.',
      'يجب أن تطابق أسماء الضرائب ضرائب المبيعات في Odoo (مثل "15%").',
      'المعرّفات الخارجية (__export__.tmanage_...) تجعل الاستيراد الثاني يحدّث السجلات نفسها.',
    ].join('\r\n'),
  },
};

export const validateOdoo = (files: readonly ExportFile[]): string[] => validateFiles(ODOO, files);
