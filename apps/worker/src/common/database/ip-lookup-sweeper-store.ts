import type { WorkerDatabase } from './worker-database.js';
import type { IpLookupSweepStore } from '../../jobs/ip-lookup-sweeper.js';

/**
 * R12 (R1). The IP-cache sweep's one statement, over the worker's pool. `tmanage_worker` holds
 * SELECT and DELETE on `ip_lookups` (scripts/db/users.sql, 0280). The bound is a bound JS Date;
 * the order rides `ix_ip_lookups_last_seen`.
 */
const DELETE_UNSEEN = `DELETE FROM ip_lookups WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?`;

export function createIpLookupSweepStore(database: WorkerDatabase): IpLookupSweepStore {
  return {
    deleteUnseenSince: (cutoff, limit) =>
      database.transaction(async (tx) => {
        const result = await tx.query<{ affectedRows: number }>(DELETE_UNSEEN, [
          cutoff,
          Math.max(1, Math.trunc(limit)),
        ]);
        return result.affectedRows;
      }),
  };
}
