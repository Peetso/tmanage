import { nextRefusalState } from '@tmanage/mail';
import type { RecipientBounceRecord, RefusalRecorder } from '@tmanage/mail';
import type { WorkerDatabase } from './worker-database.js';

/**
 * MAILREST — the worker's write of an SMTP-time recipient refusal into `mail_recipient_bounces`
 * (0366/0370), the store the bounce intake writes and `BounceGuardMailer` reads. One transaction:
 * the (company, address hash) row by primary key `FOR UPDATE`, the next state from the intake's
 * rules (`nextRefusalState`), then one INSERT or UPDATE. Always bound to the company the message
 * was sent for; the raw address is never stored.
 *
 * Grant (users.sql, WIRING): SELECT, INSERT, UPDATE on `mail_recipient_bounces` for
 * `tmanage_worker`. Without it the write fails, `SmtpRefusalMailer` logs one line and the send's
 * outcome is unchanged.
 */

export const BOUNCE_REFUSAL_SQL = {
  read: `SELECT hard_count, soft_count, last_kind, last_status, last_message_ref, last_bounced_at,
         suppressed_at
    FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ? LIMIT 1 FOR UPDATE`,
  insert: `INSERT IGNORE INTO mail_recipient_bounces
    (organization_id, address_hash, hard_count, soft_count, last_kind, last_status,
     last_message_ref, last_bounced_at, suppressed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  update: `UPDATE mail_recipient_bounces
     SET hard_count = ?, soft_count = ?, last_kind = ?, last_status = ?, last_message_ref = ?,
         last_bounced_at = ?, suppressed_at = ?, updated_at = ?
   WHERE organization_id = ? AND address_hash = ?`,
} as const;

interface BounceRow {
  readonly hard_count: number | string;
  readonly soft_count: number | string;
  readonly last_kind: string;
  readonly last_status: string;
  readonly last_message_ref: string;
  readonly last_bounced_at: Date | string;
  readonly suppressed_at: Date | string | null;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

function recordOf(row: BounceRow): RecipientBounceRecord {
  return {
    hardCount: Number(row.hard_count),
    softCount: Number(row.soft_count),
    lastKind: row.last_kind,
    lastStatus: row.last_status,
    lastMessageRef: row.last_message_ref,
    lastBouncedAt: toDate(row.last_bounced_at),
    suppressedAt: row.suppressed_at === null ? null : toDate(row.suppressed_at),
  };
}

export function createBounceRefusalRecorder(database: WorkerDatabase): RefusalRecorder {
  return {
    async recordRefusal({ organizationId, addressHash, refusal, reference, at }) {
      await database.transaction(async (tx) => {
        const found = await tx.query<readonly BounceRow[]>(BOUNCE_REFUSAL_SQL.read, [
          organizationId,
          addressHash,
        ]);
        const existing = found[0] === undefined ? null : recordOf(found[0]);
        const next = nextRefusalState(existing, refusal, reference, at);
        if (next === null) return;
        const fields = [
          next.hardCount,
          next.softCount,
          next.lastKind,
          next.lastStatus,
          next.lastMessageRef,
          next.lastBouncedAt,
          next.suppressedAt,
        ];
        if (existing === null) {
          await tx.query(BOUNCE_REFUSAL_SQL.insert, [
            organizationId,
            addressHash,
            ...fields,
            at,
            at,
          ]);
        } else {
          await tx.query(BOUNCE_REFUSAL_SQL.update, [...fields, at, organizationId, addressHash]);
        }
      });
    },
  };
}
