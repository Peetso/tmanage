import type { BounceSuppressionLookup } from '@tmanage/mail';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 56-26 — the worker's read of `mail_recipient_bounces` (0366): has this company stopped mail to
 * this address hash? One primary-key probe per company mail, always bound to the company the
 * message is sent for. Grant: SELECT on `mail_recipient_bounces` for `tmanage_worker` (users.sql).
 */
export function createBounceSuppressionLookup(database: WorkerDatabase): BounceSuppressionLookup {
  return {
    async isBounceSuppressed(organizationId: string, addressHash: string): Promise<boolean> {
      const rows = await database.read((tx) =>
        tx.query<readonly unknown[]>(
          `SELECT 1 AS hit FROM mail_recipient_bounces
            WHERE organization_id = ? AND address_hash = ? AND suppressed_at IS NOT NULL LIMIT 1`,
          [organizationId, addressHash],
        ),
      );
      return rows.length > 0;
    },
  };
}
