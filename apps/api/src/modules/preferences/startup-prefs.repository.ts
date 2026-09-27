import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userStartupPrefs } from '../../common/database/schema.js';
import type { LandingKey, UserStartupPrefRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PREF-STARTUP's startup-preference store — read one member's default landing view, write it, and
 * nothing else (module 20 Preferences & accessibility, x287).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's preferences: a
 * startup preference is one member's, and a method without a `membershipId` parameter would be the
 * one place that rule could be dropped — the same shape `a11y_preferences` and `pref_quiet_hours`
 * take for their per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_user_startup_prefs_org_membership`. Two saves racing for one member's row serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the landing key, and
 * `updated_at` follows the column's `ON UPDATE`.
 */
export class StartupPrefsRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<UserStartupPrefRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userStartupPrefs)
      .where(
        and(
          eq(userStartupPrefs.organizationId, context.organizationId),
          eq(userStartupPrefs.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's startup landing view in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    landingKey: LandingKey,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userStartupPrefs)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        landingKey,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          landingKey,
        },
      });
  }
}
