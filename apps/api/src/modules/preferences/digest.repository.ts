import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { digestPreferences } from '../../common/database/schema.js';
import type { DigestPreference, DigestPreferenceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PREF-DIGEST's digest-cadence store — read one member's notification digest cadence, write it, and
 * nothing else (module 20 Preferences & accessibility, x245).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's cadences: a
 * digest row is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the same shape `pref_quiet_hours` and `a11y_preferences` take for
 * their per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_pref_digest_org_membership`. Two saves racing for one member's row serialise on the unique key
 * rather than on a row this code read first, so a lost update is not expressible. The insert path
 * fills `id`; the update path leaves it alone and moves only the settings, and `updated_at` follows
 * the column's `ON UPDATE`.
 */
export class DigestPreferenceRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<DigestPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(digestPreferences)
      .where(
        and(
          eq(digestPreferences.organizationId, context.organizationId),
          eq(digestPreferences.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's digest cadence in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    settings: DigestPreference,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(digestPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        digestJson: settings,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          digestJson: settings,
        },
      });
  }
}
