import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientCreditNoteLines,
  clientCreditNotes,
  clientInvoiceEvents,
  clientInvoiceLines,
  clientInvoicePayments,
  clientInvoices,
  clientMemberships,
  clientOrganizationBilling,
  expenses,
  orgExchangeRates,
  orgFinanceProfiles,
  orgSettings,
  projectClients,
  quoteLines,
  quotes,
  retainerPeriods,
  retainers,
  timeLogPricing,
  timePeriodLocks,
} from '../../common/database/schema.js';
import type {
  ClientCreditNoteLineRow,
  ClientCreditNoteRow,
  ClientInvoiceEventRow,
  ClientInvoiceLineRow,
  ClientInvoicePaymentRow,
  ClientInvoiceRow,
  ClientOrganizationBillingRow,
} from '../../common/database/schema.js';
import type { QueryRows, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PullExpenseRow, PullQuote, PullRetainer, PullTimeRow } from './invoice-pull.js';

/**
 * 52-09 — storage for the six 0301 tables and the reads the pull-in needs (approved time, approved
 * billable expenses, the retainer period, an accepted quote), the source links written at send and
 * the 52-03 locks. Every statement carries the `organization_id` predicate; another organization's
 * row is simply absent. No policy here.
 */

export type InvoiceChange = Partial<
  Omit<ClientInvoiceRow, 'id' | 'organizationId' | 'createdBy' | 'createdAt'>
>;

export type LineChange = Partial<
  Omit<ClientInvoiceLineRow, 'id' | 'organizationId' | 'invoiceId' | 'createdAt'>
>;

export interface AgingRow {
  readonly currency: string;
  readonly dueDate: string | null;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly depositAppliedMinor: number;
}

// Approved, billable, not yet invoiced time on the client's projects in the period. The timesheet
// join keeps only entries of an approved week; the first word of the display name is all a line
// may carry.
const APPROVED_TIME_SQL = `SELECT l.id, l.minutes, DATE_FORMAT(l.spent_on, '%Y-%m-%d') AS spent_on,
       l.rate_snapshot_minor, l.work_item_id, w.title, l.logged_by,
       SUBSTRING_INDEX(TRIM(u.display_name), ' ', 1) AS first_name
  FROM work_item_time_logs l
  JOIN timesheets t ON t.organization_id = l.organization_id AND t.id = l.timesheet_id
  LEFT JOIN work_items w ON w.organization_id = l.organization_id AND w.id = l.work_item_id
  LEFT JOIN memberships m ON m.organization_id = l.organization_id AND m.id = l.logged_by
  LEFT JOIN users u ON u.id = m.user_id
 WHERE l.organization_id = ? AND t.state = 'approved' AND l.billable = 1
   AND l.invoice_line_id IS NULL AND l.spent_on BETWEEN ? AND ?
   AND l.project_id IN (SELECT pc.project_id FROM project_clients pc
                         WHERE pc.organization_id = ? AND pc.client_organization_id = ?)
 ORDER BY l.spent_on, l.id
 LIMIT 5000`;

// The same window's billable minutes still waiting on an approval: never pulled, only counted.
const WAITING_TIME_SQL = `SELECT COALESCE(SUM(l.minutes), 0) AS minutes
  FROM work_item_time_logs l
  LEFT JOIN timesheets t ON t.organization_id = l.organization_id AND t.id = l.timesheet_id
 WHERE l.organization_id = ? AND l.billable = 1 AND l.invoice_line_id IS NULL
   AND l.spent_on BETWEEN ? AND ?
   AND (t.id IS NULL OR t.state <> 'approved')
   AND l.project_id IN (SELECT pc.project_id FROM project_clients pc
                         WHERE pc.organization_id = ? AND pc.client_organization_id = ?)`;

export class ClientInvoicesRepository {
  // ---- client, profile-adjacent reads ----

  async clientBilling(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationBillingRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientOrganizationBilling)
      .where(
        and(
          eq(clientOrganizationBilling.organizationId, organizationId),
          eq(clientOrganizationBilling.id, clientOrganizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async projectLinkedToClient(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projectClients.id })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, organizationId),
          eq(projectClients.clientOrganizationId, clientOrganizationId),
          eq(projectClients.projectId, projectId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The latest rate for the pair on or before `onOrBefore`, as DECIMAL text. */
  async exchangeRate(
    runner: TenantQueryRunner,
    organizationId: string,
    fromCurrency: string,
    toCurrency: string,
    onOrBefore: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ rate: orgExchangeRates.rate })
      .from(orgExchangeRates)
      .where(
        and(
          eq(orgExchangeRates.organizationId, organizationId),
          eq(orgExchangeRates.fromCurrency, fromCurrency),
          eq(orgExchangeRates.toCurrency, toCurrency),
          lte(orgExchangeRates.effectiveOn, onOrBefore),
        ),
      )
      .orderBy(desc(orgExchangeRates.effectiveOn))
      .limit(1);
    return rows[0]?.rate ?? null;
  }

  /** Open 52-03 locks that hold `day`. */
  async locksHolding(
    runner: TenantQueryRunner,
    organizationId: string,
    day: string,
  ): Promise<readonly { periodStart: string; periodEnd: string; unlockedAt: Date | null }[]> {
    return tenantDrizzle(runner)
      .select({
        periodStart: timePeriodLocks.periodStart,
        periodEnd: timePeriodLocks.periodEnd,
        unlockedAt: timePeriodLocks.unlockedAt,
      })
      .from(timePeriodLocks)
      .where(
        and(
          eq(timePeriodLocks.organizationId, organizationId),
          lte(timePeriodLocks.periodStart, day),
          gte(timePeriodLocks.periodEnd, day),
          isNull(timePeriodLocks.unlockedAt),
        ),
      )
      .limit(10);
  }

  async setting(
    runner: TenantQueryRunner,
    organizationId: string,
    key: string,
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ value: orgSettings.settingValue })
      .from(orgSettings)
      .where(and(eq(orgSettings.organizationId, organizationId), eq(orgSettings.settingKey, key)))
      .limit(1);
    return rows[0]?.value;
  }

  /** The active client admins of a client organization (the inbox notice of a send). */
  async clientAdminUserIds(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: clientMemberships.userId })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, organizationId),
          eq(clientMemberships.clientOrganizationId, clientOrganizationId),
          eq(clientMemberships.role, 'client_admin'),
          eq(clientMemberships.status, 'active'),
        ),
      )
      .limit(50);
    return rows.map((r) => r.userId);
  }

  // ---- invoices ----

  async insertInvoice(runner: TenantQueryRunner, row: ClientInvoiceRow): Promise<void> {
    await tenantDrizzle(runner).insert(clientInvoices).values(row);
  }

  async findInvoice(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<ClientInvoiceRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(clientInvoices)
      .where(and(eq(clientInvoices.organizationId, organizationId), eq(clientInvoices.id, id)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async updateInvoice(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    change: InvoiceChange,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(clientInvoices)
      .set(change)
      .where(and(eq(clientInvoices.organizationId, organizationId), eq(clientInvoices.id, id)));
  }

  /** Newest first (ids are UUIDv7). `clientOrganizationId` narrows to one client (the portal). */
  async listInvoices(
    runner: TenantQueryRunner,
    organizationId: string,
    filter: {
      readonly state: string | null;
      readonly clientOrganizationId: string | null;
      readonly cursor: string | null;
      readonly excludeDrafts?: boolean;
      readonly limit: number;
    },
  ): Promise<readonly ClientInvoiceRow[]> {
    const predicates = [eq(clientInvoices.organizationId, organizationId)];
    if (filter.state !== null) predicates.push(eq(clientInvoices.state, filter.state as never));
    if (filter.clientOrganizationId !== null) {
      predicates.push(eq(clientInvoices.clientOrganizationId, filter.clientOrganizationId));
    }
    if (filter.cursor !== null) predicates.push(lt(clientInvoices.id, filter.cursor));
    if (filter.excludeDrafts === true) {
      predicates.push(notInArray(clientInvoices.state, ['draft', 'void']));
    }
    return tenantDrizzle(runner)
      .select()
      .from(clientInvoices)
      .where(and(...predicates))
      .orderBy(desc(clientInvoices.id))
      .limit(filter.limit);
  }

  /** Every issued, unsettled invoice (the aging read). */
  async openInvoices(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<readonly AgingRow[]> {
    return tenantDrizzle(runner)
      .select({
        currency: clientInvoices.currency,
        dueDate: clientInvoices.dueDate,
        totalMinor: clientInvoices.totalMinor,
        paidMinor: clientInvoices.paidMinor,
        depositAppliedMinor: clientInvoices.depositAppliedMinor,
      })
      .from(clientInvoices)
      .where(
        and(
          eq(clientInvoices.organizationId, organizationId),
          inArray(clientInvoices.state, ['sent', 'partially_paid']),
        ),
      )
      .limit(10_000);
  }

  // ---- lines ----

  async lines(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly ClientInvoiceLineRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientInvoiceLines)
      .where(
        and(
          eq(clientInvoiceLines.organizationId, organizationId),
          eq(clientInvoiceLines.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(clientInvoiceLines.position));
  }

  async insertLines(
    runner: TenantQueryRunner,
    rows: readonly ClientInvoiceLineRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tenantDrizzle(runner)
      .insert(clientInvoiceLines)
      .values([...rows]);
  }

  async updateLine(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    change: LineChange,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(clientInvoiceLines)
      .set(change)
      .where(
        and(eq(clientInvoiceLines.organizationId, organizationId), eq(clientInvoiceLines.id, id)),
      );
  }

  async deleteLines(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    await tenantDrizzle(runner)
      .delete(clientInvoiceLines)
      .where(
        and(
          eq(clientInvoiceLines.organizationId, organizationId),
          eq(clientInvoiceLines.invoiceId, invoiceId),
          inArray(clientInvoiceLines.id, [...ids]),
        ),
      );
  }

  /** A re-pull's first step: the pulled lines go, the manual ones stay. */
  async deletePulledLines(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(clientInvoiceLines)
      .where(
        and(
          eq(clientInvoiceLines.organizationId, organizationId),
          eq(clientInvoiceLines.invoiceId, invoiceId),
          ne(clientInvoiceLines.sourceType, 'manual'),
        ),
      );
  }

  // ---- payments, credit notes, events ----

  async payments(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly ClientInvoicePaymentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientInvoicePayments)
      .where(
        and(
          eq(clientInvoicePayments.organizationId, organizationId),
          eq(clientInvoicePayments.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(clientInvoicePayments.paidOn), asc(clientInvoicePayments.id))
      .limit(500);
  }

  async insertPayment(runner: TenantQueryRunner, row: ClientInvoicePaymentRow): Promise<void> {
    await tenantDrizzle(runner).insert(clientInvoicePayments).values(row);
  }

  async creditNotes(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly ClientCreditNoteRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientCreditNotes)
      .where(
        and(
          eq(clientCreditNotes.organizationId, organizationId),
          eq(clientCreditNotes.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(clientCreditNotes.issuedAt))
      .limit(200);
  }

  async insertCreditNote(
    runner: TenantQueryRunner,
    row: ClientCreditNoteRow,
    lines: readonly ClientCreditNoteLineRow[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db.insert(clientCreditNotes).values(row);
    if (lines.length > 0) await db.insert(clientCreditNoteLines).values([...lines]);
  }

  async insertEvent(runner: TenantQueryRunner, row: ClientInvoiceEventRow): Promise<void> {
    await tenantDrizzle(runner).insert(clientInvoiceEvents).values(row);
  }

  async hasEventSince(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
    kind: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: clientInvoiceEvents.id })
      .from(clientInvoiceEvents)
      .where(
        and(
          eq(clientInvoiceEvents.organizationId, organizationId),
          eq(clientInvoiceEvents.invoiceId, invoiceId),
          eq(clientInvoiceEvents.kind, kind),
          gte(clientInvoiceEvents.createdAt, since),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  // ---- the pull-in sources ----

  async approvedTime(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    from: string,
    to: string,
  ): Promise<readonly PullTimeRow[]> {
    const rows = await runner.execute<QueryRows>(APPROVED_TIME_SQL, [
      organizationId,
      from,
      to,
      organizationId,
      clientOrganizationId,
    ]);
    return rows.map((r) => ({
      id: String(r['id']),
      minutes: Number(r['minutes']),
      spentOn: String(r['spent_on']),
      rateMinor: r['rate_snapshot_minor'] === null ? null : Number(r['rate_snapshot_minor']),
      workItemId: r['work_item_id'] === null ? null : String(r['work_item_id']),
      title: r['title'] === null || r['title'] === undefined ? null : String(r['title']),
      membershipId: String(r['logged_by']),
      firstName:
        r['first_name'] === null || r['first_name'] === undefined || r['first_name'] === ''
          ? null
          : String(r['first_name']).slice(0, 60),
    }));
  }

  async waitingMinutes(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const rows = await runner.execute<QueryRows>(WAITING_TIME_SQL, [
      organizationId,
      from,
      to,
      organizationId,
      clientOrganizationId,
    ]);
    return Number(rows[0]?.['minutes'] ?? 0);
  }

  /** Approved, billable, not yet invoiced expenses of the client (directly or by project). */
  async approvedExpenses(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    projectIds: readonly string[],
    from: string,
    to: string,
  ): Promise<readonly PullExpenseRow[]> {
    const db = tenantDrizzle(runner);
    const owner =
      projectIds.length === 0
        ? eq(expenses.clientOrganizationId, clientOrganizationId)
        : sql`(${expenses.clientOrganizationId} = ${clientOrganizationId} OR ${inArray(expenses.projectId, [...projectIds])})`;
    const rows = await db
      .select({
        id: expenses.id,
        spentOn: expenses.spentOn,
        category: expenses.category,
        amountBaseMinor: expenses.amountBaseMinor,
        markupBp: expenses.markupBp,
        billable: expenses.billable,
        taxBp: expenses.taxBp,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          eq(expenses.state, 'approved'),
          eq(expenses.billable, true),
          isNull(expenses.invoiceLineId),
          gte(expenses.spentOn, from),
          lte(expenses.spentOn, to),
          owner,
        ),
      )
      .orderBy(asc(expenses.spentOn), asc(expenses.id))
      .limit(1000);
    return rows.map((r) => ({
      ...r,
      amountBaseMinor: r.amountBaseMinor === null ? null : Number(r.amountBaseMinor),
    }));
  }

  /** The client's projects (`project_clients`). */
  async clientProjectIds(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: projectClients.projectId })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, organizationId),
          eq(projectClients.clientOrganizationId, clientOrganizationId),
        ),
      )
      .limit(500);
    return rows.map((r) => r.projectId);
  }

  /** The client's first not-yet-invoiced retainer period with an amount overlapping the window. */
  async retainerPeriod(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    from: string,
    to: string,
  ): Promise<PullRetainer | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        periodId: retainerPeriods.id,
        name: retainers.name,
        periodStart: retainerPeriods.periodStart,
        periodEnd: retainerPeriods.periodEnd,
        amountPerPeriodMinor: retainers.amountPerPeriodMinor,
      })
      .from(retainerPeriods)
      .innerJoin(
        retainers,
        and(
          eq(retainers.organizationId, retainerPeriods.organizationId),
          eq(retainers.id, retainerPeriods.retainerId),
        ),
      )
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainers.clientOrganizationId, clientOrganizationId),
          isNull(retainerPeriods.invoiceId),
          lte(retainerPeriods.periodStart, to),
          gte(retainerPeriods.periodEnd, from),
        ),
      )
      .orderBy(asc(retainerPeriods.periodStart))
      .limit(5);
    const row = rows.find((r) => r.amountPerPeriodMinor !== null);
    return row === undefined
      ? null
      : { ...row, amountPerPeriodMinor: Number(row.amountPerPeriodMinor) };
  }

  /** An accepted quote of this client, with its lines; `null` when absent or not accepted. */
  async acceptedQuote(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    quoteId: string,
  ): Promise<(PullQuote & { readonly currency: string }) | null> {
    const db = tenantDrizzle(runner);
    const head = await db
      .select({ number: quotes.number, currency: quotes.currency })
      .from(quotes)
      .where(
        and(
          eq(quotes.organizationId, organizationId),
          eq(quotes.id, quoteId),
          eq(quotes.clientOrganizationId, clientOrganizationId),
          eq(quotes.status, 'accepted'),
        ),
      )
      .limit(1);
    const quote = head[0];
    if (quote === undefined) return null;
    const lines = await db
      .select({
        description: quoteLines.description,
        unit: quoteLines.unit,
        quantityCenti: quoteLines.quantityCenti,
        unitPriceMinor: quoteLines.unitPriceMinor,
        taxBp: quoteLines.taxBp,
        lineNetMinor: quoteLines.lineNetMinor,
      })
      .from(quoteLines)
      .where(and(eq(quoteLines.organizationId, organizationId), eq(quoteLines.quoteId, quoteId)))
      .orderBy(asc(quoteLines.position))
      .limit(200);
    return { number: quote.number, currency: quote.currency, lines };
  }

  // ---- the links written at send, released by a void ----

  /** Links still-free time logs to a line; returns how many were linked. */
  async linkTimeLogs(
    runner: TenantQueryRunner,
    organizationId: string,
    ids: readonly string[],
    lineId: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tenantDrizzle(runner)
      .update(timeLogPricing)
      .set({ invoiceLineId: lineId })
      .where(
        and(
          eq(timeLogPricing.organizationId, organizationId),
          inArray(timeLogPricing.id, [...ids]),
          isNull(timeLogPricing.invoiceLineId),
        ),
      );
    return affected(result);
  }

  /** Links still-free approved expenses to a line and locks them (0292 triggers). */
  async linkExpenses(
    runner: TenantQueryRunner,
    organizationId: string,
    ids: readonly string[],
    lineId: string,
    at: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tenantDrizzle(runner)
      .update(expenses)
      .set({ invoiceLineId: lineId, lockedAt: at })
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          inArray(expenses.id, [...ids]),
          eq(expenses.state, 'approved'),
          isNull(expenses.invoiceLineId),
        ),
      );
    return affected(result);
  }

  async linkRetainerPeriod(
    runner: TenantQueryRunner,
    organizationId: string,
    periodId: string,
    invoiceId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(retainerPeriods)
      .set({ invoiceId })
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainerPeriods.id, periodId),
          isNull(retainerPeriods.invoiceId),
        ),
      );
    return affected(result);
  }

  /** A void releases whatever its lines hold (a draft normally holds nothing). */
  async releaseLinks(
    runner: TenantQueryRunner,
    organizationId: string,
    invoiceId: string,
    lineIds: readonly string[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    if (lineIds.length > 0) {
      await db
        .update(timeLogPricing)
        .set({ invoiceLineId: null })
        .where(
          and(
            eq(timeLogPricing.organizationId, organizationId),
            inArray(timeLogPricing.invoiceLineId, [...lineIds]),
          ),
        );
      await db
        .update(expenses)
        .set({ invoiceLineId: null, lockedAt: null })
        .where(
          and(
            eq(expenses.organizationId, organizationId),
            inArray(expenses.invoiceLineId, [...lineIds]),
          ),
        );
    }
    await db
      .update(retainerPeriods)
      .set({ invoiceId: null })
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainerPeriods.invoiceId, invoiceId),
        ),
      );
  }

  // ---- 52-12 (0311) hash chain ----

  /**
   * Serialises every chain link of the organization: one row lock on its finance profile, taken
   * inside the send / credit-note transaction. Invoices and credit notes take different document
   * sequences (`DocumentSequenceService` locks one row per kind), so the counter they share needs
   * this single lock to stay gapless and unique across both tables.
   */
  async lockChain(runner: TenantQueryRunner, organizationId: string): Promise<void> {
    await tenantDrizzle(runner)
      .select({ organizationId: orgFinanceProfiles.organizationId })
      .from(orgFinanceProfiles)
      .where(eq(orgFinanceProfiles.organizationId, organizationId))
      .limit(1)
      .for('update');
  }

  /** The last link: the highest ICV over invoices and credit notes, or null for the first. */
  async chainHead(runner: TenantQueryRunner, organizationId: string): Promise<ChainHead | null> {
    const db = tenantDrizzle(runner);
    const invoice = await db
      .select({ icv: clientInvoices.zatcaIcv, xmlHash: clientInvoices.zatcaXmlHash })
      .from(clientInvoices)
      .where(
        and(eq(clientInvoices.organizationId, organizationId), isNotNull(clientInvoices.zatcaIcv)),
      )
      .orderBy(desc(clientInvoices.zatcaIcv))
      .limit(1)
      .for('update');
    const note = await db
      .select({ icv: clientCreditNotes.zatcaIcv, xmlHash: clientCreditNotes.zatcaXmlHash })
      .from(clientCreditNotes)
      .where(
        and(
          eq(clientCreditNotes.organizationId, organizationId),
          isNotNull(clientCreditNotes.zatcaIcv),
        ),
      )
      .orderBy(desc(clientCreditNotes.zatcaIcv))
      .limit(1)
      .for('update');
    const heads = [...invoice, ...note].filter(
      (h): h is { icv: number; xmlHash: string } => h.icv !== null && h.xmlHash !== null,
    );
    if (heads.length === 0) return null;
    return heads.reduce((a, b) => (Number(b.icv) > Number(a.icv) ? b : a));
  }
}

export interface ChainHead {
  readonly icv: number;
  readonly xmlHash: string;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const rows = (header as { affectedRows?: unknown } | undefined)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}
