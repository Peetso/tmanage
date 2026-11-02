/**
 * 52-11 — accounting export by file: the canonical rows every target maps from.
 *
 * The API reads these from the 0301 tables (invoice-level data only: never cost rates, member
 * cost or internal notes) and hands them to {@link buildExport}. Amounts are integer minor units
 * of their own currency, rates are basis points, dates are ISO `YYYY-MM-DD`. A person's name is
 * carried only by {@link ExpenseExportRow.submitterName} (the `expenses` kind).
 */

import type { CsvValue } from '../../export/csv.js';

export const EXPORT_TARGETS = [
  'zoho_books',
  'odoo',
  'qoyod',
  'wafeq',
  'quickbooks',
  'xero',
  'generic',
] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export const EXPORT_KINDS = [
  'invoices',
  'credit_notes',
  'payments',
  'customers',
  'expenses',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportTarget(value: unknown): value is ExportTarget {
  return typeof value === 'string' && (EXPORT_TARGETS as readonly string[]).includes(value);
}

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === 'string' && (EXPORT_KINDS as readonly string[]).includes(value);
}

/** ZATCA/UBL tax categories: standard, zero-rated, exempt, out of scope. */
export type TaxCategory = 'S' | 'Z' | 'E' | 'O';

export interface InvoiceLineExportRow {
  readonly position: number;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  /** Hundredths: 150 = 1.5. */
  readonly quantityCenti: number;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly discountBp: number;
  readonly taxBp: number;
  readonly taxCategory: string | null;
  readonly lineDiscountMinor: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  readonly lineGrossMinor: number;
}

export interface InvoiceExportRow {
  readonly id: string;
  readonly number: string;
  readonly kind: string;
  readonly state: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly supplyDate: string | null;
  readonly currency: string;
  /** Decimal string (DECIMAL(18,8)) or `null` when the invoice is in the base currency. */
  readonly fxRate: string | null;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly poNumber: string | null;
  /** The customer-facing notes printed on the invoice (never `internal_note`). */
  readonly notes: string | null;
  readonly terms: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerNameAr: string | null;
  readonly customerEmail: string | null;
  readonly customerAddress: string | null;
  readonly lines: readonly InvoiceLineExportRow[];
}

export interface CreditNoteLineExportRow {
  readonly position: number;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly quantityCenti: number;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly taxBp: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  readonly lineGrossMinor: number;
}

export interface CreditNoteExportRow {
  readonly id: string;
  readonly number: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly issueDate: string;
  readonly currency: string;
  readonly reason: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerNameAr: string | null;
  readonly lines: readonly CreditNoteLineExportRow[];
}

export interface PaymentExportRow {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: string;
  readonly reference: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerNameAr: string | null;
}

export interface CustomerExportRow {
  readonly id: string;
  readonly name: string;
  readonly legalNameEn: string | null;
  readonly legalNameAr: string | null;
  readonly taxRegistrationNo: string | null;
  readonly billingAddressEn: string | null;
  readonly billingAddressAr: string | null;
  readonly billingEmail: string | null;
  readonly defaultCurrency: string | null;
}

export interface ExpenseExportRow {
  readonly id: string;
  readonly spentOn: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly taxBp: number;
  readonly billable: boolean;
  readonly markupBp: number;
  readonly note: string | null;
  /** The submitter's display name — the one personal name an export carries (kind `expenses`). */
  readonly submitterName: string | null;
}

export interface ExportInput {
  readonly invoices: readonly InvoiceExportRow[];
  readonly creditNotes: readonly CreditNoteExportRow[];
  readonly payments: readonly PaymentExportRow[];
  readonly customers: readonly CustomerExportRow[];
  readonly expenses: readonly ExpenseExportRow[];
}

export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';

/** How the validator reads a column. */
export type ColumnType = 'text' | 'date' | 'amount' | 'quantity' | 'percent' | 'tax';

/** Formatting for one target run (date format, tax map, Latin-only switch). */
export interface ExportFormatter {
  date(iso: string | null): string;
  amount(minor: number, currency: string): string;
  quantity(centi: number): string;
  percent(bp: number): string;
  tax(bp: number, category?: string | null): string;
  /** A description: EN and AR joined, or EN only (Arabic stripped) when Latin-only. */
  text(en: string | null, ar: string | null): string;
  /** An Arabic-only column: blank when Latin-only. */
  arabic(ar: string | null): string;
  /** True when the run strips Arabic text (systems that choke on RTL). */
  readonly latinOnly: boolean;
}

export interface ColumnSpec<R> {
  readonly name: string;
  readonly type: ColumnType;
  readonly required: boolean;
  /** `doc` columns are blank on continuation rows when the file uses {@link FileSpec.continuation}. */
  readonly scope: 'doc' | 'line';
  readonly value: (row: R, f: ExportFormatter) => CsvValue;
}

/** One CSV of a target: its name, its columns (the header) and how its rows are drawn. */
export interface FileSpec {
  readonly kind: ExportKind;
  readonly name: string;
  readonly header: readonly string[];
  readonly columns: readonly Omit<ColumnSpec<never>, 'value'>[];
  /** Odoo-style multi-line documents: lines after the first leave the `doc` columns blank. */
  readonly continuation: boolean;
  rows(input: ExportInput, f: ExportFormatter): CsvValue[][];
}

export interface TargetMap {
  readonly target: ExportTarget;
  readonly label: string;
  readonly files: readonly FileSpec[];
  readonly dateFormat: DateFormat;
  readonly decimals: 2;
  /** Tax label per category; `{rate}` is replaced by the percentage (`15`). */
  readonly taxCodeMap: Readonly<Record<TaxCategory, string>>;
  /** The day the column map was checked against the vendor's published import template. */
  readonly templateCheckedOn: string;
  readonly readme: { readonly en: string; readonly ar: string };
}

export interface ExportFile {
  readonly name: string;
  readonly text: string;
}
