import { eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizationLimits } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 62-07. A platform admin's raise of the caller's own workspace's monthly AI credits:
 * `organization_limits.ai_credits_limit` (0383; NULL = the plan's figure). Bound to
 * `context.organizationId`; there is no organization-id input. The storage raise's shape
 * (`storage-allowance.repository.ts`).
 */
export class AiAllowanceRepository {
  async findRaiseCredits(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<number | null> {
    const rows = await tenantDrizzle(runner)
      .select({ credits: organizationLimits.aiCreditsLimit })
      .from(organizationLimits)
      .where(eq(organizationLimits.organizationId, context.organizationId))
      .limit(1);
    const credits = rows[0]?.credits;
    return credits === null || credits === undefined ? null : Number(credits);
  }
}
