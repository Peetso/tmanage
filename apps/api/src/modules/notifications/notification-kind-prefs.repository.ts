import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_NOTIFICATION_PROFILE, isNotificationProfile, uuidv7 } from '@tmanage/domain';
import type { NotificationProfile } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { notificationKindPrefs, orgSettings } from '../../common/database/schema.js';
import type { NotificationKind, NotificationKindPrefRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Per-kind notification opt-out's store (x152) — a membership's per-kind settings, read and upserted,
 * and nothing else.
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's opt-outs: a
 * setting is one seat's, and a method without a `membershipId` parameter would be the one place that
 * rule could be dropped — the same shape `home_pinned_items` and `notification_preferences` take.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_notification_kind_prefs_pref`. Two saves racing for one (membership, kind) serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id` and `updated_at`; the update path moves only `enabled`, and `updated_at`
 * follows by the column's `ON UPDATE`.
 */
export class NotificationKindPrefsRepository {
  /**
   * Every per-kind row the acting membership holds in this tenant. Unset kinds have no row — the
   * service fills their default (enabled) — so this returns only the settings a person has chosen.
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly NotificationKindPrefRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(notificationKindPrefs)
      .where(
        and(
          eq(notificationKindPrefs.organizationId, context.organizationId),
          eq(notificationKindPrefs.membershipId, membershipId),
        ),
      );
  }

  /**
   * 55-18 (R18-d) — the org's notification profile, which decides how an **unset** kind is delivered
   * (immediately or in the digest). One keyed read of `org_settings`; absent or unknown = `calm`.
   */
  async findNotificationProfile(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<NotificationProfile> {
    const rows = await tenantDrizzle(runner)
      .select({ value: orgSettings.settingValue })
      .from(orgSettings)
      .where(
        and(
          eq(orgSettings.organizationId, context.organizationId),
          eq(orgSettings.settingKey, 'notification_profile'),
        ),
      )
      .limit(1);
    const value = rows[0]?.value;
    return isNotificationProfile(value) ? value : DEFAULT_NOTIFICATION_PROFILE;
  }

  /**
   * Create or replace this membership's setting for one kind. Idempotent by the unique pref key: a
   * second save of the same (membership, kind) updates `enabled` in place rather than adding a row.
   * The id and tenant come from here, never from input.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    kind: NotificationKind,
    enabled: boolean,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(notificationKindPrefs)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        kind,
        enabled,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { enabled } });
  }
}
