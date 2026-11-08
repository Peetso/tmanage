import {
  DEFAULT_NOTIFICATION_PROFILE,
  effectiveMatrixCell,
  isNotificationProfile,
  parseForcedEmailKinds,
  parseStoredMatrix,
} from '@tmanage/domain';
import type { NotificationMatrixCell, NaturalNotificationKind } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 53-15 — one member's effective notification-matrix cell for one kind, read at delivery inside
 * the consumer's transaction, so the cell honoured is the one in force now.
 *
 * One statement, four keyed sub-reads, all scoped to the event's organization:
 * `notification_kind_prefs` (the In-app master switch), `user_preferences.prefs_json`'s
 * `notificationMatrix` (E-mail / Digest), and two `org_settings` keys (the profile defaults and the
 * company-forced e-mail kinds). A missing row at any of them is the default, never an error.
 * Grants (users.sql, worker): SELECT on `notification_kind_prefs` (exists), `user_preferences`,
 * `org_settings`.
 */
export async function findMemberMatrixCell(
  tx: WorkerTransaction,
  organizationId: string,
  membershipId: string,
  kind: NaturalNotificationKind,
): Promise<NotificationMatrixCell> {
  interface Row {
    readonly kind_enabled: number | null;
    readonly matrix_json: unknown;
    readonly profile: string | null;
    readonly forced: string | null;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT
       (SELECT enabled FROM notification_kind_prefs
         WHERE organization_id = ? AND membership_id = ? AND kind = ?) AS kind_enabled,
       (SELECT JSON_EXTRACT(prefs_json, '$.notificationMatrix') FROM user_preferences
         WHERE organization_id = ? AND membership_id = ?) AS matrix_json,
       (SELECT setting_value FROM org_settings
         WHERE organization_id = ? AND setting_key = 'notification_profile') AS profile,
       (SELECT setting_value FROM org_settings
         WHERE organization_id = ? AND setting_key = 'notification_forced_email_kinds') AS forced`,
    [
      organizationId,
      membershipId,
      kind,
      organizationId,
      membershipId,
      organizationId,
      organizationId,
    ],
  );
  const row = rows[0];
  const profile = isNotificationProfile(row?.profile) ? row.profile : DEFAULT_NOTIFICATION_PROFILE;
  const enabled = row?.kind_enabled;
  return effectiveMatrixCell({
    profile,
    kind,
    kindEnabled: enabled === null || enabled === undefined ? undefined : Boolean(enabled),
    stored: parseStoredMatrix(row?.matrix_json ?? null),
    forcedEmail: parseForcedEmailKinds(row?.forced).includes(kind),
  });
}
