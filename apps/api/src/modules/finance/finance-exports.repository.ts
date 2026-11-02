import { and, asc, desc, eq, gte, inArray, lt, lte, notInArray } from 'drizzle-orm';
import type {
  CreditNoteExportRow,
  CreditNoteLineExportRow,
  CustomerExportRow,
  ExpenseExportRow,
  InvoiceExportRow,
  InvoiceLineExportRow,
  PaymentExportRow,
} from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientCreditNoteLines,
  clientCreditNotes,
  clientInvoiceLines,
  clientInvoicePayments,
  clientInvoices,
  clientOrganizationBilling,
  expenses,
  financeExports,
  memberships,
  users,
} from '../../common/database/schema.js';
import type { FinanceExportRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-11 — the reads an accounting export draws from (the 0301 invoices, lines, payments, credit
 * notes, client billing columns and the 52-07 approved expenses), the 0304 history and the
 * exported marks. Every statement carries the `organization_id` predicate.
 *
 * The selections are explicit and exported so a test can hold them to "invoice-level data only":
 * no cost rate, member cost, internal note or source link is ever selected.
 */

/** States that never leave TManage: an unsent draft and a voided draft. */
const NOT_EXPORTED_STATES = ['draft', 'void'] as const;
const CHUNK = 1000;

export const INVOICE_EXPORT_COLUMNS = {
  id: clientInvoices.id,
  number: clientInvoices.number,
  kind: clientInvoices.kind,
  state: clientInvoices.state,
  issueDate: clientInvoices.issueDate,
  dueDate: clientInvoices.dueDate,
  supplyDate: clientInvoices.supplyDate,
  currency: clientInvoices.currency,
  fxRate: clientInvoices.fxRate,
  subtotalMinor: clientInvoices.subtotalMinor,
  discountMinor: clientInvoices.discountMinor,
  taxMinor: clientInvoices.taxMinor,
  totalMinor: clientInvoices.totalMinor,
  poNumber: clientInvoices.poNumber,
  notesText: clientInvoices.notesText,
  termsText: clientInvoices.termsText,
  clientOrganizationId: clientInvoices.clientOrganizationId,
  exportedAt: clientInvoices.exportedAt,
  clientName: clientOrganizationBilling.name,
  legalNameEn: clientOrganizationBilling.legalNameEn,
  legalNameAr: clientOrganizationBilling.legalNameAr,
  billingEmail: clientOrganizationBilling.billingEmail,
  billingAddressEn: clientOrganizationBilling.billingAddressEn,
} as const;

export const INVOICE_LINE_EXPORT_COLUMNS = {
  invoiceId: clientInvoiceLines.invoiceId,
  position: clientInvoiceLines.position,
  descriptionEn: clientInvoiceLines.descriptionEn,
  descriptionAr: clientInvoiceLines.descriptionAr,
  quantityCenti: clientInvoiceLines.quantityCenti,
  unit: clientInvoiceLines.unit,
  unitPriceMinor: clientInvoiceLines.unitPriceMinor,
  discountBp: clientInvoiceLines.discountBp,
  taxBp: clientInvoiceLines.taxBp,
  taxCategory: clientInvoiceLines.taxCategory,
  lineDiscountMinor: clientInvoiceLines.lineDiscountMinor,
  lineNetMinor: clientInvoiceLines.lineNetMinor,
  lineTaxMinor: clientInvoiceLines.lineTaxMinor,
  lineGrossMinor: clientInvoiceLines.lineGrossMinor,
} as const;

export const CREDIT_NOTE_EXPORT_COLUMNS = {
  id: clientCreditNotes.id,
  number: clientCreditNotes.number,
  invoiceId: clientCreditNotes.invoiceId,
  reason: clientCreditNotes.reason,
  subtotalMinor: clientCreditNotes.subtotalMinor,
  taxMinor: clientCreditNotes.taxMinor,
  totalMinor: clientCreditNotes.totalMinor,
  issuedAt: clientCreditNotes.issuedAt,
  exportedAt: clientCreditNotes.exportedAt,
  invoiceNumber: clientInvoices.number,
  currency: clientInvoices.currency,
  clientOrganizationId: clientInvoices.clientOrganizationId,
  clientName: clientOrganizationBilling.name,
  legalNameEn: clientOrganizationBilling.legalNameEn,
  legalNameAr: clientOrganizationBilling.legalNameAr,
} as const;

export const CREDIT_NOTE_LINE_EXPORT_COLUMNS = {
  creditNoteId: clientCreditNoteLines.creditNoteId,
  position: clientCreditNoteLines.position,
  descriptionEn: clientCreditNoteLines.descriptionEn,
  descriptionAr: clientCreditNoteLines.descriptionAr,
  quantityCenti: clientCreditNoteLines.quantityCenti,
  unit: clientCreditNoteLines.unit,
  unitPriceMinor: clientCreditNoteLines.unitPriceMinor,
  taxBp: clientCreditNoteLines.taxBp,
  lineNetMinor: clientCreditNoteLines.lineNetMinor,
  lineTaxMinor: clientCreditNoteLines.lineTaxMinor,
  lineGrossMinor: clientCreditNoteLines.lineGrossMinor,
} as const;

export const PAYMENT_EXPORT_COLUMNS = {
  id: clientInvoicePayments.id,
  invoiceId: clientInvoicePayments.invoiceId,
  paidOn: clientInvoicePayments.paidOn,
  amountMinor: clientInvoicePayments.amountMinor,
  currency: clientInvoicePayments.currency,
  method: clientInvoicePayments.method,
  reference: clientInvoicePayments.reference,
  invoiceNumber: clientInvoices.number,
  clientOrganizationId: clientInvoices.clientOrganizationId,
  clientName: clientOrganizationBilling.name,
  legalNameEn: clientOrganizationBilling.legalNameEn,
  legalNameAr: clientOrganizationBilling.legalNameAr,
} as const;

export const CUSTOMER_EXPORT_COLUMNS = {
  id: clientOrganizationBilling.id,
  name: clientOrganizationBilling.name,
  legalNameEn: clientOrganizationBilling.legalNameEn,
  legalNameAr: clientOrganizationBilling.legalNameAr,
  taxRegistrationNo: clientOrganizationBilling.taxRegistrationNo,
  billingAddressEn: clientOrganizationBilling.billingAddressEn,
  billingAddressAr: clientOrganizationBilling.billingAddressAr,
  billingEmail: clientOrganizationBilling.billingEmail,
  defaultCurrency: clientOrganizationBilling.defaultCurrency,
} as const;

/** The submitter's display name is the one personal name selected (kind `expenses` only). */
export const EXPENSE_EXPORT_COLUMNS = {
  id: expenses.id,
  spentOn: expenses.spentOn,
  category: expenses.category,
  amountMinor: expenses.amountMinor,
  currency: expenses.currency,
  taxBp: expenses.taxBp,
  billable: expenses.billable,
  markupBp: expenses.markupBp,
  note: expenses.note,
  submitterName: users.displayName,
} as const;

export interface InvoiceExportRead extends InvoiceExportRow {
  readonly exportedAt: Date | null;
}

/** R23-d (0315): the credit note's export mark rides along; the service strips it. */
export interface CreditNoteExportRead extends CreditNoteExportRow {
  readonly exportedAt: Date | null;
}

const num = (value: unknown): number => Number(value ?? 0);
const dayOf = (value: string | Date | null): string =>
  value === null ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : value;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const billingJoin = (organizationId: string) =>
  and(
    eq(clientOrganizationBilling.organizationId, organizationId),
    eq(clientOrganizationBilling.id, clientInvoices.clientOrganizationId),
  );

export class FinanceExportsRepository {
  /** Issued invoices (not draft, not void) with `issue_date` in the period, at most `limit`. */
  async invoices(
    runner: TenantQueryRunner,
    organizationId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<readonly InvoiceExportRead[]> {
    const rows = await tenantDrizzle(runner)
      .select(INVOICE_EXPORT_COLUMNS)
      .from(clientInvoices)
      .leftJoin(clientOrganizationBilling, billingJoin(organizationId))
      .where(
        and(
          eq(clientInvoices.organizationId, organizationId),
          notInArray(clientInvoices.state, [...NOT_EXPORTED_STATES]),
          gte(clientInvoices.issueDate, from),
          lte(clientInvoices.issueDate, to),
        ),
      )
      .orderBy(asc(clientInvoices.issueDate), asc(clientInvoices.number))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      number: r.number ?? '',
      kind: r.kind,
      state: r.state,
      issueDate: dayOf(r.issueDate),
      dueDate: r.dueDate,
      supplyDate: r.supplyDate,
      currency: r.currency,
      fxRate: r.fxRate,
      subtotalMinor: num(r.subtotalMinor),
      discountMinor: num(r.discountMinor),
      taxMinor: num(r.taxMinor),
      totalMinor: num(r.totalMinor),
      poNumber: r.poNumber,
      notes: r.notesText,
      terms: r.termsText,
      customerId: r.clientOrganizationId,
      customerName: r.legalNameEn ?? r.clientName ?? '',
      customerNameAr: r.legalNameAr ?? null,
      customerEmail: r.billingEmail ?? null,
      customerAddress: r.billingAddressEn ?? null,
      exportedAt: r.exportedAt,
      lines: [],
    }));
  }

  async invoiceLines(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceIds: readonly string[],
  ): Promise<ReadonlyMap<string, InvoiceLineExportRow[]>> {
    const byInvoice = new Map<string, InvoiceLineExportRow[]>();
    for (const ids of chunks(invoiceIds)) {
      const rows = await tenantDrizzle(runner)
        .select(INVOICE_LINE_EXPORT_COLUMNS)
        .from(clientInvoiceLines)
        .where(
          and(
            eq(clientInvoiceLines.organizationId, organizationId),
            inArray(clientInvoiceLines.invoiceId, ids),
          ),
        )
        .orderBy(asc(clientInvoiceLines.invoiceId), asc(clientInvoiceLines.position));
      for (const { invoiceId, ...line } of rows) {
        const list = byInvoice.get(invoiceId) ?? [];
        list.push({
          ...line,
          unitPriceMinor: num(line.unitPriceMinor),
          lineDiscountMinor: num(line.lineDiscountMinor),
          lineNetMinor: num(line.lineNetMinor),
          lineTaxMinor: num(line.lineTaxMinor),
          lineGrossMinor: num(line.lineGrossMinor),
        });
        byInvoice.set(invoiceId, list);
      }
    }
    return byInvoice;
  }

  /** Credit notes issued in `[from, toExclusive)`. */
  async creditNotes(
    runner: TenantQueryRunner,
    organizationId: string,
    from: Date,
    toExclusive: Date,
    limit: number,
  ): Promise<readonly CreditNoteExportRead[]> {
    const rows = await tenantDrizzle(runner)
      .select(CREDIT_NOTE_EXPORT_COLUMNS)
      .from(clientCreditNotes)
      .innerJoin(
        clientInvoices,
        and(
          eq(clientInvoices.organizationId, organizationId),
          eq(clientInvoices.id, clientCreditNotes.invoiceId),
        ),
      )
      .leftJoin(clientOrganizationBilling, billingJoin(organizationId))
      .where(
        and(
          eq(clientCreditNotes.organizationId, organizationId),
          gte(clientCreditNotes.issuedAt, from),
          lt(clientCreditNotes.issuedAt, toExclusive),
        ),
      )
      .orderBy(asc(clientCreditNotes.issuedAt), asc(clientCreditNotes.number))
      .limit(limit);
    const lines = await this.creditNoteLines(
      runner,
      organizationId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      issueDate: dayOf(r.issuedAt),
      currency: r.currency,
      reason: r.reason,
      subtotalMinor: num(r.subtotalMinor),
      taxMinor: num(r.taxMinor),
      totalMinor: num(r.totalMinor),
      customerId: r.clientOrganizationId,
      customerName: r.legalNameEn ?? r.clientName ?? '',
      customerNameAr: r.legalNameAr ?? null,
      exportedAt: r.exportedAt,
      lines: lines.get(r.id) ?? [],
    }));
  }

  private async creditNoteLines(
    runner: TenantQueryRunner,
    organizationId: string,
    noteIds: readonly string[],
  ): Promise<ReadonlyMap<string, CreditNoteLineExportRow[]>> {
    const byNote = new Map<string, CreditNoteLineExportRow[]>();
    for (const ids of chunks(noteIds)) {
      const rows = await tenantDrizzle(runner)
        .select(CREDIT_NOTE_LINE_EXPORT_COLUMNS)
        .from(clientCreditNoteLines)
        .where(
          and(
            eq(clientCreditNoteLines.organizationId, organizationId),
            inArray(clientCreditNoteLines.creditNoteId, ids),
          ),
        )
        .orderBy(asc(clientCreditNoteLines.creditNoteId), asc(clientCreditNoteLines.position));
      for (const { creditNoteId, ...line } of rows) {
        const list = byNote.get(creditNoteId) ?? [];
        list.push({
          ...line,
          unitPriceMinor: num(line.unitPriceMinor),
          lineNetMinor: num(line.lineNetMinor),
          lineTaxMinor: num(line.lineTaxMinor),
          lineGrossMinor: num(line.lineGrossMinor),
        });
        byNote.set(creditNoteId, list);
      }
    }
    return byNote;
  }

  /** Payments with `paid_on` in the period. */
  async payments(
    runner: TenantQueryRunner,
    organizationId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<readonly PaymentExportRow[]> {
    const rows = await tenantDrizzle(runner)
      .select(PAYMENT_EXPORT_COLUMNS)
      .from(clientInvoicePayments)
      .innerJoin(
        clientInvoices,
        and(
          eq(clientInvoices.organizationId, organizationId),
          eq(clientInvoices.id, clientInvoicePayments.invoiceId),
        ),
      )
      .leftJoin(clientOrganizationBilling, billingJoin(organizationId))
      .where(
        and(
          eq(clientInvoicePayments.organizationId, organizationId),
          gte(clientInvoicePayments.paidOn, from),
          lte(clientInvoicePayments.paidOn, to),
        ),
      )
      .orderBy(asc(clientInvoicePayments.paidOn), asc(clientInvoicePayments.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      paidOn: r.paidOn,
      amountMinor: num(r.amountMinor),
      currency: r.currency,
      method: r.method,
      reference: r.reference,
      customerId: r.clientOrganizationId,
      customerName: r.legalNameEn ?? r.clientName ?? '',
      customerNameAr: r.legalNameAr ?? null,
    }));
  }

  async customers(
    runner: TenantQueryRunner,
    organizationId: string,
    clientIds: readonly string[],
  ): Promise<readonly CustomerExportRow[]> {
    const out: CustomerExportRow[] = [];
    for (const ids of chunks(clientIds)) {
      const rows = await tenantDrizzle(runner)
        .select(CUSTOMER_EXPORT_COLUMNS)
        .from(clientOrganizationBilling)
        .where(
          and(
            eq(clientOrganizationBilling.organizationId, organizationId),
            inArray(clientOrganizationBilling.id, ids),
          ),
        )
        .orderBy(asc(clientOrganizationBilling.name));
      out.push(...rows);
    }
    return out;
  }

  /** Approved expenses with `spent_on` in the period, with the submitter's display name. */
  async expenses(
    runner: TenantQueryRunner,
    organizationId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<readonly ExpenseExportRow[]> {
    const rows = await tenantDrizzle(runner)
      .select(EXPENSE_EXPORT_COLUMNS)
      .from(expenses)
      .leftJoin(
        memberships,
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.id, expenses.membershipId),
        ),
      )
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          eq(expenses.state, 'approved'),
          gte(expenses.spentOn, from),
          lte(expenses.spentOn, to),
        ),
      )
      .orderBy(asc(expenses.spentOn), asc(expenses.id))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      amountMinor: num(r.amountMinor),
      billable: Boolean(r.billable),
      submitterName: r.submitterName ?? null,
    }));
  }

  async insertExport(runner: TenantQueryRunner, row: FinanceExportRow): Promise<void> {
    await tenantDrizzle(runner).insert(financeExports).values(row);
  }

  /** Stamp `exported_at` / `export_target` (the 0301 trigger lets both move after send). */
  async markInvoicesExported(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceIds: readonly string[],
    at: Date,
    target: string,
  ): Promise<void> {
    for (const ids of chunks(invoiceIds)) {
      await tenantDrizzle(runner)
        .update(clientInvoices)
        .set({ exportedAt: at, exportTarget: target })
        .where(
          and(eq(clientInvoices.organizationId, organizationId), inArray(clientInvoices.id, ids)),
        );
    }
  }

  /** R23-d (0315): the credit-note twin of `markInvoicesExported`, chunked and org-scoped. */
  async markCreditNotesExported(
    runner: TenantQueryRunner,
    organizationId: string,
    creditNoteIds: readonly string[],
    at: Date,
    target: string,
  ): Promise<void> {
    for (const ids of chunks(creditNoteIds)) {
      await tenantDrizzle(runner)
        .update(clientCreditNotes)
        .set({ exportedAt: at, exportTarget: target })
        .where(
          and(
            eq(clientCreditNotes.organizationId, organizationId),
            inArray(clientCreditNotes.id, ids),
          ),
        );
    }
  }

  /** The newest export runs first. */
  async listExports(
    runner: TenantQueryRunner,
    organizationId: string,
    limit: number,
  ): Promise<readonly FinanceExportRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(financeExports)
      .where(eq(financeExports.organizationId, organizationId))
      .orderBy(desc(financeExports.createdAt), desc(financeExports.id))
      .limit(limit);
  }
}
