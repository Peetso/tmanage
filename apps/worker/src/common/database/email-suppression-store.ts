import type { SuppressionLookup } from '@tmanage/mail';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 51-11 — the worker's read of `email_suppressions` (0252): is this recipient's address hash
 * unsubscribed from notification mail? One primary-key probe per notification send, on the
 * worker's own pool. Grant: SELECT on `email_suppressions` for `tmanage_worker` (users.sql).
 */
export function createEmailSuppressionLookup(database: WorkerDatabase): SuppressionLookup {
  return {
    async isSuppressed(addressHash: string): Promise<boolean> {
      const rows = await database.read((tx) =>
        tx.query<readonly unknown[]>(
          `SELECT 1 AS hit FROM email_suppressions
            WHERE address_hash = ? AND scope = 'notifications' LIMIT 1`,
          [addressHash],
        ),
      );
      return rows.length > 0;
    },
  };
}
