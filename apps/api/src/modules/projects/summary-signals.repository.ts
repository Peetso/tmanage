import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * B10 — the one scope fact the client page's Risks lines need beyond the briefing's own reads:
 * which of the listed invoices belong to this client company. Bound SQL, the organization from
 * the verified context. Grants (app role): SELECT on `client_invoices` (already held).
 */
export const SUMMARY_SIGNALS_SQL = {
  clientInvoiceIds: (ids: number) => `SELECT id FROM client_invoices
 WHERE organization_id = ? AND client_organization_id = ? AND id IN (${marks(ids)})`,
} as const;

function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export class SummarySignalsRepository {
  async clientInvoiceIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
    invoiceIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (invoiceIds.length === 0) return new Set();
    const rows = await runner.execute<QueryRows>(
      SUMMARY_SIGNALS_SQL.clientInvoiceIds(invoiceIds.length),
      [context.organizationId, clientOrganizationId, ...invoiceIds],
    );
    return new Set(rows.map((row) => String(row['id'])));
  }
}
