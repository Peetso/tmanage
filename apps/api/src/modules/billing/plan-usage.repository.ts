import { and, eq, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientMemberships, projects } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The two usage counts the "Plan and usage" screen (Figma F4) needs that no other repository
 * already reads: active projects and client people. Both are plain counts over existing tables,
 * bound to `context.organizationId` — there is no organization-id input to name another tenant.
 * Internal people come from {@link SubscriptionRepository.countInternalPeople} and storage from
 * the `storage.bytes` usage counter, so nothing is counted twice.
 */
export class PlanUsageRepository {
  /** Projects that are not archived. Archived projects never count against a plan. */
  async countActiveProjects(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), isNull(projects.archivedAt)));
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Distinct client people with an active client membership. One person in two client
   * organizations is one client. Clients are always free; the count is shown, never billed.
   */
  async countClientPeople(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(distinct ${clientMemberships.userId})` })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.status, 'active'),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
}
