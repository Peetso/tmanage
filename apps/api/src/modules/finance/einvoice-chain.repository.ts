import { desc, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { einvoiceChainChecks } from '../../common/database/schema.js';
import type { EinvoiceChainCheckRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The `documents` column shares its name with the tenant table `documents`. Drizzle writes a
 * single-table select's columns unqualified, and the tenant guard fails closed on a bare tenant
 * table name it cannot place ("tenant table 'documents' appears in a position this guard cannot
 * analyse"), so the plain `.select()` was refused and the chain route answered 500 (A9). Written
 * as `einvoice_chain_checks`.`documents` the guard reads it as a column. Plain identifiers only:
 * MariaDB-safe.
 */
const DOCUMENTS_COLUMN = sql<number>`${sql.identifier('einvoice_chain_checks')}.${sql.identifier(
  'documents',
)}`.mapWith(Number);

/**
 * 52-12 (R22-b, 0314) — the one read of the worker's chain verdicts: the newest row of one
 * organization (`ix_ecc_org_checked`). The app holds SELECT only; the worker writes and prunes.
 */
export class EinvoiceChainRepository {
  async latest(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<EinvoiceChainCheckRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: einvoiceChainChecks.id,
        organizationId: einvoiceChainChecks.organizationId,
        checkedAt: einvoiceChainChecks.checkedAt,
        status: einvoiceChainChecks.status,
        headIcv: einvoiceChainChecks.headIcv,
        documents: DOCUMENTS_COLUMN,
        breakIcv: einvoiceChainChecks.breakIcv,
        breakReason: einvoiceChainChecks.breakReason,
        detailJson: einvoiceChainChecks.detailJson,
      })
      .from(einvoiceChainChecks)
      .where(eq(einvoiceChainChecks.organizationId, organizationId))
      .orderBy(desc(einvoiceChainChecks.checkedAt), desc(einvoiceChainChecks.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
