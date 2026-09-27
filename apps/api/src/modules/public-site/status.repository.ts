import { desc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { incidents } from '../../common/database/schema.js';
import type { IncidentRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Public status-page storage (x159) — the published-only incidents read.
 *
 * `incidents` is a GLOBAL, org-less table (0060), so every method takes an
 * {@link IdentityQueryRunner} and nothing else: there is no `TenantContext` here and there could
 * not be, because the public status page is read before any organization is named — see
 * `TenantDatabase.identityRead()` and the table's entry in `NON_TENANT_TABLES`.
 *
 * The `published = 1` predicate is the public-visibility gate and it lives here, in the SQL: a draft
 * incident is never returned by this read. The service re-applies the same filter and the ordering
 * as defence in depth, but the database is the boundary that must hold even if a caller reaches this
 * repository another way.
 */
export class StatusRepository {
  /** Published incidents, newest first by `started_at`, bounded to `limit`. */
  async listPublishedIncidents(
    runner: IdentityQueryRunner,
    limit: number,
  ): Promise<readonly IncidentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(incidents)
      .where(eq(incidents.published, true))
      .orderBy(desc(incidents.startedAt))
      .limit(limit);
  }
}
