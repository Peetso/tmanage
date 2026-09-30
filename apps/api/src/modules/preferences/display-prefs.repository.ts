import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userDisplayPreferences } from '../../common/database/schema.js';
import type { DisplayPreferences, UserDisplayPreferenceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PREF-DISPLAY's preferences store — read one member's display settings, write them, and nothing
 * else (module 20 Preferences & accessibility, x285).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's preferences:
 * a preference is one member's, and a method without a `membershipId` parameter would be the one
 * place that rule could be dropped — the same shape `a11y_preferences` takes for its per-membership
 * reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_user_display_preferences_org_membership`. Two saves racing for one member's row serialise on
 * the unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the settings, and
 * `updated_at` follows the column's `ON UPDATE`.
 */
export class DisplayPreferencesRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<UserDisplayPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userDisplayPreferences)
      .where(
        and(
          eq(userDisplayPreferences.organizationId, context.organizationId),
          eq(userDisplayPreferences.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's settings in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    settings: DisplayPreferences,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userDisplayPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        displayJson: settings,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          displayJson: settings,
        },
      });
  }
}
