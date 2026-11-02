/**
 * AI action registry — 52-28 (R19-a) tax-document rules: the one read op's detail. The label and
 * tax-registration routes are NEVER (`never.ts`, `finance_settings`): a label on a fiscal document
 * and a registration reference are the agency's own legal claims.
 */
import { det, noArgs, type AiActionDetail } from './detail.js';

export const taxDocumentDetails: readonly AiActionDetail[] = [
  det({
    id: 'finance.tax_document_rules.get',
    redact: 'finance',
    notifies: false,
    title: 'Show the tax-document rules',
    description:
      "The organization's country rule for invoice labels: e-invoice regime, the default label " +
      '(proforma in KSA/Egypt when VAT registered), which labels are allowed and whether the ' +
      '"not a tax invoice" notice is printed.',
    descriptionAr:
      'قاعدة الدولة لتسمية الفواتير: نظام الفوترة الإلكترونية، والتسمية الافتراضية (فاتورة مبدئية ' +
      'في السعودية ومصر عند التسجيل في ضريبة القيمة المضافة)، والتسميات المسموحة، وهل يُطبع تنبيه ' +
      '«ليست فاتورة ضريبية».',
    input: noArgs(),
    examples: [
      { summary: 'Can we label our invoices as tax invoices?', args: {} },
      { summary: 'Why do our invoices say proforma?', args: {} },
    ],
  }),
];
