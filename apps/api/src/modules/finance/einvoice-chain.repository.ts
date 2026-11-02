import { desc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { einvoiceChainChecks } from '../../common/database/schema.js';
import type { EinvoiceChainCheckRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

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
      .select()
      .from(einvoiceChainChecks)
      .where(eq(einvoiceChainChecks.organizationId, organizationId))
      .orderBy(desc(einvoiceChainChecks.checkedAt), desc(einvoiceChainChecks.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
