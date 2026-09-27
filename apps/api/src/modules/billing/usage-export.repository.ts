import { asc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { usageCounters } from '../../common/database/schema.js';
import type { UsageCounterRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & entitlements (module 19, x227). The usage-export repository — the data-access layer behind
 * the date-windowed usage CSV export, following the tenant-scoped repository pattern
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6), distinct from the x200 usage-alerts read:
 *
 * 1. **No unscoped read.** The only method takes the `TenantQueryRunner` for the unit of work and the
 *    `TenantContext`; there is no overload without a context, and the tenant predicate is on the
 *    statement, executed through the guard (`drizzle.ts`) so a forgotten predicate throws rather than
 *    leaking another customer's counters.
 * 2. **The tenant comes from the context, never a query parameter.** The window filter and the row cap
 *    are the service/controller's, applied over the rows this returns; this file only reads the
 *    tenant's `usage_counters` and adds no counting.
 * 3. **Bounded read.** The read is capped at `limit` rows (the service passes the export ceiling plus
 *    one) so an unbounded counter table can never be scanned whole into one response — the service
 *    refuses with 413 when the extra row comes back.
 */
export class UsageExportRepository {
  /**
   * Read the acting tenant's usage counters, metric-key ascending, at most `limit` rows. The window
   * filter (over `updatedAt`) and the CSV serialization are the controller's; the 413 row-cap decision
   * is the service's, from whether this returns more than the ceiling.
   */
  async listForExport(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<readonly UsageCounterRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.organizationId, context.organizationId))
      .orderBy(asc(usageCounters.metricKey))
      .limit(limit);
  }
}
