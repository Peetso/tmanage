import { eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizationLimits } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 57-13r. The support raise of the caller's own workspace: `organization_limits`
 * `storage_bytes_limit` (PA-07, written only by a platform admin). Bound to
 * `context.organizationId`; there is no organization-id input.
 */
export class StorageAllowanceRepository {
  async findOverrideBytes(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<number | null> {
    const rows = await tenantDrizzle(runner)
      .select({ bytes: organizationLimits.storageBytesLimit })
      .from(organizationLimits)
      .where(eq(organizationLimits.organizationId, context.organizationId))
      .limit(1);
    const bytes = rows[0]?.bytes;
    return bytes === null || bytes === undefined ? null : Number(bytes);
  }
}
