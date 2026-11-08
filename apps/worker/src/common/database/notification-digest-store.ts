import { MATRIX_KINDS, belongsInDigest, matrixKindOf } from '@tmanage/domain';
import type { NotificationMatrixCell, NaturalNotificationKind } from '@tmanage/domain';
import {
  DIGEST_SENT_TYPE,
  type DigestCadenceValue,
  type DigestRecipient,
  type DigestWindow,
  type NotificationDigestStore,
} from '../../jobs/notification-digest.js';
import type { DigestEmailFacts } from '../../notifications/digest-mailer.js';
import { findMemberMatrixCell } from './notification-matrix-store.js';
import { findUsageMailRecipient, insertNotification } from './notifications-store.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 53-15 — the SQL behind `jobs/notification-digest.ts`, as `tmanage_worker`. Grants (users.sql):
 * SELECT on `memberships`, `pref_digest`, `notification_preferences`, `org_settings`,
 * `organizations`, `notifications`, `users`, `notification_kind_prefs`, `user_preferences`;
 * INSERT on `notifications` (all but three exist — see the slice's registry fragment).
 */

// The one cross-tenant read: active internal members with their cadence and zone. A member with
// no `pref_digest` row has the shipped default (daily at 08:00).
const LIST_RECIPIENTS = `SELECT m.organization_id, m.id AS membership_id, m.user_id,
       pd.digest_json, np.quiet_hours_timezone, os.setting_value AS org_timezone
  FROM memberships m
  LEFT JOIN pref_digest pd
         ON pd.organization_id = m.organization_id AND pd.membership_id = m.id
  LEFT JOIN notification_preferences np
         ON np.organization_id = m.organization_id AND np.user_id = m.user_id
  LEFT JOIN org_settings os
         ON os.organization_id = m.organization_id AND os.setting_key = 'default_timezone'
 WHERE m.status = 'active' AND m.role <> 'platform_support'
 ORDER BY m.organization_id, m.id
 LIMIT ?`;

const LIST_UNREAD = `SELECT type FROM notifications
 WHERE organization_id = ? AND recipient_user_id = ? AND read_at IS NULL AND created_at >= ?
 ORDER BY id DESC
 LIMIT 500`;

const ORG_NAME = `SELECT name, slug FROM organizations WHERE id = ?`;

interface RecipientRow {
  readonly organization_id: string;
  readonly membership_id: string;
  readonly user_id: string;
  readonly digest_json: unknown;
  readonly quiet_hours_timezone: string | null;
  readonly org_timezone: string | null;
}

/** Pure: a stored `digest_json` (object or JSON text) as cadence / hour / weekday, with defaults. */
export function parseDigestJson(raw: unknown): {
  readonly cadence: DigestCadenceValue;
  readonly sendHour: number;
  readonly dayOfWeek: number;
} {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const record =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const cadence = record['cadence'];
  const hour = record['sendHour'];
  const day = record['dayOfWeek'];
  return {
    cadence: cadence === 'immediate' || cadence === 'weekly' ? cadence : 'daily',
    sendHour:
      typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    dayOfWeek: typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6 ? day : 0,
  };
}

export function createNotificationDigestStore(database: WorkerDatabase): NotificationDigestStore {
  return {
    async listRecipients(limit: number): Promise<readonly DigestRecipient[]> {
      const rows = await database.read((tx) =>
        tx.query<readonly RecipientRow[]>(LIST_RECIPIENTS, [limit]),
      );
      return rows.map((row) => ({
        organizationId: row.organization_id,
        membershipId: row.membership_id,
        userId: row.user_id,
        ...parseDigestJson(row.digest_json),
        timezone: row.quiet_hours_timezone ?? row.org_timezone ?? 'UTC',
      }));
    },

    async collectAndClaim(
      recipient: DigestRecipient,
      window: DigestWindow,
      links: (path: string) => string,
    ): Promise<DigestEmailFacts | null> {
      return database.transaction(async (tx) => {
        const person = await findUsageMailRecipient(tx, recipient.organizationId, recipient.userId);
        if (person === null || !person.emailEnabled) return null;
        const unread = await tx.query<readonly { type: string }[]>(LIST_UNREAD, [
          recipient.organizationId,
          recipient.userId,
          window.since,
        ]);
        const cells = new Map<NaturalNotificationKind, NotificationMatrixCell>();
        const counts: Partial<Record<NaturalNotificationKind, number>> = {};
        for (const { type } of unread) {
          const kind = matrixKindOf(type);
          if (kind === null || !MATRIX_KINDS.includes(kind)) continue;
          let cell = cells.get(kind);
          if (cell === undefined) {
            cell = await findMemberMatrixCell(
              tx,
              recipient.organizationId,
              recipient.membershipId,
              kind,
            );
            cells.set(kind, cell);
          }
          if (belongsInDigest(type, cell)) counts[kind] = (counts[kind] ?? 0) + 1;
        }
        if (Object.keys(counts).length === 0) return null;
        const claimed = await insertNotification(tx, {
          organizationId: recipient.organizationId,
          recipientUserId: recipient.userId,
          type: DIGEST_SENT_TYPE,
          objectType: 'membership',
          objectId: recipient.membershipId,
          dedupeKey: window.key,
        });
        if (!claimed) return null; // Another pass or worker already sent this window.
        const orgs = await tx.query<readonly { name: string; slug: string }[]>(ORG_NAME, [
          recipient.organizationId,
        ]);
        const org = orgs[0];
        if (org === undefined) return null;
        return {
          recipientEmail: person.email,
          recipientName: person.displayName,
          organizationName: org.name,
          locale: person.locale,
          cadence: window.cadence,
          counts,
          inboxLink: links(`/${org.slug}/inbox`),
          settingsLink: links(`/${org.slug}/inbox/notification-preferences`),
        };
      });
    },
  };
}
