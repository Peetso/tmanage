import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userPreferences } from '../../common/database/schema.js';
import type { UserPreferenceRow, UserPreferencesJson } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PREF-001's preferences store — read one membership's settings, write them, and nothing else.
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's preferences: a
 * preference is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped. The read and the write are both scoped by `membership_id = the acting
 * context's membership`, so a member reaches only their own row even inside one tenant — the own-
 * principal substance the slice turns on.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_user_preferences_org_membership`. Two saves racing for one member's row serialise on the unique
 * key rather than on a row this code read first, so a lost update is not expressible. The insert path
 * fills `id` and the create timestamp; the update path leaves both alone and moves only `prefs_json`,
 * and `updated_at` follows by the column's `ON UPDATE`.
 */
export class PreferencesRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<UserPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userPreferences)
      .where(
        and(
          eq(userPreferences.organizationId, context.organizationId),
          eq(userPreferences.membershipId, membershipId),
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
    prefs: UserPreferencesJson,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        prefsJson: prefs,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { prefsJson: prefs } });
  }
}
