import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { quietHours } from '../../common/database/schema.js';
import type { QuietHours, QuietHoursRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PREF-QUIET's quiet-hours store — read one member's do-not-disturb window, write it, and nothing
 * else (module 20 Preferences & accessibility, x215).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's windows: a
 * quiet-hours row is one member's, and a method without a `membershipId` parameter would be the one
 * place that rule could be dropped — the same shape `a11y_preferences` takes for its per-membership
 * reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_pref_quiet_hours_org_membership`. Two saves racing for one member's row serialise on the unique
 * key rather than on a row this code read first, so a lost update is not expressible. The insert path
 * fills `id`; the update path leaves it alone and moves only the settings, and `updated_at` follows
 * the column's `ON UPDATE`.
 */
export class QuietHoursRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<QuietHoursRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(quietHours)
      .where(
        and(
          eq(quietHours.organizationId, context.organizationId),
          eq(quietHours.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's window in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    settings: QuietHours,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(quietHours)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        quietJson: settings,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          quietJson: settings,
        },
      });
  }
}
