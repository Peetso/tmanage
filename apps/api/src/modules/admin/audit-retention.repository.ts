import { and, eq, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEvents, auditRetentionPolicy, organizations } from '../../common/database/schema.js';
import type { AuditRetentionPolicyRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of the audit-log retention policy (Administration module 18, x279) — the tenant-scoped
 * resolve/read/upsert of the one-row-per-organization policy, and the read-only purge-preview COUNT over
 * the existing `audit_events`. It owns the `audit_retention_policy` table alone, so the retention
 * surface stays file-disjoint from the security (x176), org-settings (x153) and audit (x115)
 * repositories in the same module.
 *
 * ## Every query is scoped to the acting tenant
 *
 * The resolve, the read, the upsert and the preview COUNT all carry an
 * `organization_id = context.organizationId` predicate, so another studio's policy is never read or
 * overwritten and another studio's audit rows are never counted. The service resolves the organization
 * tenant-scoped (via {@link resolveOrganization}) before it authorizes or writes, so a context naming an
 * organization that does not exist in this tenant is a 404 with no write.
 *
 * ## The preview never writes to `audit_events`
 *
 * {@link countEventsOlderThan} is a `SELECT count(*)` and nothing else. This slice previews how many
 * rows fall outside the window; it does not purge them. The runtime credential holds no DELETE on
 * `audit_events` (append-only), so a purge could not run from here even by mistake.
 */
export class AuditRetentionRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a 500 on a dangling upsert.
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

  /** The acting tenant's retention policy row, if one has been written — otherwise `undefined` (default). */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AuditRetentionPolicyRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(auditRetentionPolicy)
      .where(eq(auditRetentionPolicy.organizationId, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the acting tenant's retention policy, one row per organization: a first write inserts, a
   * re-save overwrites `retention_days` and who set it and when, in place. `id` and `organization_id`
   * are never changed on the update path — the 0148 trigger holds `organization_id` immutable at the
   * engine besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly retentionDays: number; readonly updatedBy: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(auditRetentionPolicy)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        retentionDays: input.retentionDays,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          retentionDays: input.retentionDays,
          updatedBy: input.updatedBy,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  /**
   * Count this tenant's `audit_events` older than the cutoff — the purge preview, read-only. Scoped by
   * `organization_id` and filtered on `created_at < cutoff`; `ix_audit_events_org_time` leads with
   * `organization_id` then `created_at`, which is exactly this predicate. Writes nothing.
   */
  async countEventsOlderThan(
    runner: TenantQueryRunner,
    context: TenantContext,
    cutoff: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          lt(auditEvents.createdAt, cutoff),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
}
