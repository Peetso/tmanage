import { and, eq, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userMfaFactors } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * A11. Whether a person holds at least one confirmed, not-disabled second factor — the fact the
 * company's "require two-step sign-in" switch is enforced on. A half-finished enrolment does not
 * count, the same rule sign-in uses (`CredentialsRepository.listActiveFactors`). No seed is read
 * or opened: only the row's existence matters here.
 */
export async function hasActiveSecondFactorRow(
  runner: IdentityQueryRunner,
  userId: string,
): Promise<boolean> {
  const rows = await tenantDrizzle(runner)
    .select({ id: userMfaFactors.id })
    .from(userMfaFactors)
    .where(
      and(
        eq(userMfaFactors.userId, userId),
        isNull(userMfaFactors.disabledAt),
        sql`${userMfaFactors.confirmedAt} is not null`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
