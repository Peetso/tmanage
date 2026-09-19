import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { notificationPreferences } from '../../common/database/schema.js';
import type { NotificationPreferenceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * NOTIF-001's preferences store — read one person's settings, write them, and nothing else.
 *
 * Both methods name a user. There is no `list(context)` that returns a studio's preferences:
 * a preference is one person's, and a method without a `userId` parameter would be the one
 * place that rule could be dropped — the same shape the notifications repository takes for
 * `recipientUserId`.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_notification_preferences_org_user`. Two saves racing for one person's row serialise on
 * the unique key rather than on a row this code read first, so a lost update is not
 * expressible. The insert path fills `id` and the create timestamp; the update path leaves
 * both alone and moves only the settings, and `updated_at` follows by the column's
 * `ON UPDATE`.
 */

/** The settings a caller can set — everything on the row except identity and timestamps. */
export interface NotificationPreferencesInput {
  readonly inAppEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly digestFrequency: 'off' | 'daily' | 'weekly';
  /** Wall-clock `HH:MM` / `HH:MM:SS` in {@link quietHoursTimezone}, or null for no quiet hours. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly quietHoursTimezone: string | null;
}

export class NotificationPreferencesRepository {
  async findForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<NotificationPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.organizationId, context.organizationId),
          eq(notificationPreferences.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this person's settings in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    input: NotificationPreferencesInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(notificationPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId,
        inAppEnabled: input.inAppEnabled,
        emailEnabled: input.emailEnabled,
        digestFrequency: input.digestFrequency,
        quietHoursStart: input.quietHoursStart,
        quietHoursEnd: input.quietHoursEnd,
        quietHoursTimezone: input.quietHoursTimezone,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          inAppEnabled: input.inAppEnabled,
          emailEnabled: input.emailEnabled,
          digestFrequency: input.digestFrequency,
          quietHoursStart: input.quietHoursStart,
          quietHoursEnd: input.quietHoursEnd,
          quietHoursTimezone: input.quietHoursTimezone,
        },
      });
  }
}
