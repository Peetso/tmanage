import { parseForcedEmailKinds, parseStoredMatrix, uuidv7 } from '@tmanage/domain';
import type { NaturalNotificationKind, StoredMatrix } from '@tmanage/domain';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DEFAULT_USER_PREFERENCES } from '../preferences/preferences.controller.js';

/** The per-cell overrides the matrix stores; In-app stays in `notification_kind_prefs`. */
export type StoredChannel = 'email' | 'digest';

/** The org setting that lists the kinds whose e-mail a member cannot turn off (53-15). */
export const FORCED_EMAIL_SETTING_KEY = 'notification_forced_email_kinds';

/**
 * 53-15 — the notification matrix's own storage, in existing tables only (no migration):
 *
 * - the **E-mail / Digest** cells live under `notificationMatrix` in the caller's own
 *   `user_preferences.prefs_json`, written by one upsert that merges just the one cell
 *   (`json_merge_patch`) — the R7 `showLastSeen` pattern — so the appearance keys and any other
 *   surface's key survive, and PREF-001's own merge keeps this key in turn;
 * - the **company force** is `org_settings.notification_forced_email_kinds` (allowlisted, written
 *   through the generic `org.manage` PUT); this store only reads it.
 *
 * Every method names the acting membership or the context's organization; there is no read of
 * another member's matrix.
 */
export class NotificationMatrixRepository {
  /** The stored cells; `{}` when the member never saved one. */
  async readStoredMatrix(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<StoredMatrix> {
    const rows = await runner.execute<QueryRows>(
      `select json_extract(prefs_json, '$.notificationMatrix') as matrix_json
         from user_preferences
        where organization_id = ? and membership_id = ?
        limit 1`,
      [context.organizationId, membershipId],
    );
    return parseStoredMatrix(rows[0]?.['matrix_json'] ?? null);
  }

  /** The kinds the company forces e-mail on for; none when unset. */
  async readForcedEmailKinds(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly NaturalNotificationKind[]> {
    const rows = await runner.execute<QueryRows>(
      `select setting_value from org_settings
        where organization_id = ? and setting_key = ?
        limit 1`,
      [context.organizationId, FORCED_EMAIL_SETTING_KEY],
    );
    const value = rows[0]?.['setting_value'];
    return parseForcedEmailKinds(typeof value === 'string' ? value : null);
  }

  /** Set one E-mail or Digest cell for the acting member, merging just that cell. */
  async writeCell(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    kind: NaturalNotificationKind,
    channel: StoredChannel,
    enabled: boolean,
  ): Promise<void> {
    const patch = JSON.stringify({ notificationMatrix: { [kind]: { [channel]: enabled } } });
    await runner.execute(
      `insert into user_preferences
         (id, organization_id, membership_id, prefs_json, created_at, updated_at)
       values (?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
       on duplicate key update prefs_json = json_merge_patch(prefs_json, ?),
                               updated_at = current_timestamp(3)`,
      [
        uuidv7(),
        context.organizationId,
        membershipId,
        JSON.stringify({
          ...DEFAULT_USER_PREFERENCES,
          notificationMatrix: { [kind]: { [channel]: enabled } },
        }),
        patch,
      ],
    );
  }
}
