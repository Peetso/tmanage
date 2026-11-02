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
/**
 * 56-13 (R18-f): the columns the public read may ever see, selected EXPLICITLY. The incident
 * register (0302) put severity, affected organizations, countries, data categories and the
 * notification timestamps on the same row; none of them is listed here, so none can reach
 * `GET /v1/public/site/status`. Only component/status/title/body/started_at/resolved_at are public
 * content; `id`, `published` (the gate) and `created_at` complete the existing response shape.
 */
export const PUBLIC_INCIDENT_COLUMNS = {
  id: incidents.id,
  component: incidents.component,
  status: incidents.status,
  title: incidents.title,
  body: incidents.body,
  startedAt: incidents.startedAt,
  resolvedAt: incidents.resolvedAt,
  published: incidents.published,
  createdAt: incidents.createdAt,
} as const;

/** One incident row as the public read selects it — never a register column. */
export type PublicIncidentRow = Pick<IncidentRow, keyof typeof PUBLIC_INCIDENT_COLUMNS>;

export class StatusRepository {
  /** Published incidents, newest first by `started_at`, bounded to `limit`. */
  async listPublishedIncidents(
    runner: IdentityQueryRunner,
    limit: number,
  ): Promise<readonly PublicIncidentRow[]> {
    return tenantDrizzle(runner)
      .select(PUBLIC_INCIDENT_COLUMNS)
      .from(incidents)
      .where(eq(incidents.published, true))
      .orderBy(desc(incidents.startedAt))
      .limit(limit);
  }
}
