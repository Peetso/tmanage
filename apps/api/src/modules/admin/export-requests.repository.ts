import { asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { adminExportRequests, organizations } from '../../common/database/schema.js';
import type { AdminExportRequestRow, AdminExportScope } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of admin data-export requests (Administration & governance, module 18, x224) — the
 * tenant-scoped list and the insert the export-request routes depend on. It owns the
 * `admin_export_requests` table alone, so the surface stays file-disjoint from the other admin
 * repositories (`roles.repository.ts`, `policies.repository.ts`).
 *
 * ## Every query is scoped to the acting tenant
 *
 * The list carries an `organization_id = context.organizationId` predicate, so another studio's export
 * requests are never read, and the insert stamps the acting tenant, so a request can never be recorded
 * for another studio. The controller resolves the organization tenant-scoped (via
 * {@link resolveOrganization}) before it authorizes or writes, so a context naming an organization
 * that does not exist in this tenant is a 404 with no write.
 *
 * A request is recorded (INSERT) and read (SELECT) only — the runtime credential holds no UPDATE or
 * DELETE. Moving a request through its status lifecycle is the later async export worker's job.
 */
export class AdminExportRequestsRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a dangling insert.
   */
  async resolveOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /** Every export request for the acting tenant, oldest first (the status screen orders newest-first). */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdminExportRequestRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(adminExportRequests)
      .where(eq(adminExportRequests.organizationId, context.organizationId))
      .orderBy(asc(adminExportRequests.requestedAt), asc(adminExportRequests.id));
  }

  /**
   * Record one export request for the acting tenant, in status `pending`. `scope` is the
   * already-validated closed-vocabulary value (the controller has proved it is one of
   * `ADMIN_EXPORT_SCOPES`); `requestedAt` is bound by the controller (never the connection clock).
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly scope: AdminExportScope;
      readonly requestedBy: string;
      readonly requestedAt: Date;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(adminExportRequests)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        scope: input.scope,
        status: 'pending',
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt,
        createdAt: sql`current_timestamp(3)`,
      });
  }
}
