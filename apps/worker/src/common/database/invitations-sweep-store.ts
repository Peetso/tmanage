import type { WorkerTransaction } from './worker-database.js';
import type { WorkerDatabase } from './worker-database.js';
import type { InvitationSweepStore } from '../../invitations/invitation-sweep.js';

/**
 * TEN-003 / ON-04: the invitation-expiry sweep's one statement, over the worker's own pool.
 *
 * The API's `invitations.repository.ts` `expireOverdue` runs the same move per tenant, under the
 * Drizzle tenant guard; the worker has no such guard and needs none here for the same reason the
 * relay's outbox claim needs none (`worker-database.ts` "Why there is no tenant guard"): this is
 * a deliberately unscoped, privileged statement that sweeps every tenant at once, and what bounds
 * it is the credential rather than a predicate. `tmanage_worker` is granted `DELETE on nothing`,
 * so the worst a defect here can do is expire an invitation early — never destroy a row.
 *
 * ## Same transition as the route, by the database clock
 *
 * `status = 'pending' AND expires_at <= current_timestamp(3)`, set to `expired`, is byte-for-byte
 * the predicate `expireOverdue` uses (23-ERD §9). `current_timestamp(3)` is read on the server,
 * never in Node: an invitation's fate must not turn on the worker host's clock drifting from the
 * database's. `accepted` and `revoked` rows are excluded by the `pending` guard and never move.
 *
 * ## Credential posture (report item)
 *
 * This statement needs `SELECT, UPDATE ON invitations` for `tmanage_worker`; the relay's existing
 * grant set (`scripts/db/users.sql`) does **not** yet include it, so the sweep will be refused
 * with `ER_TABLEACCESS_DENIED_ERROR` until that grant is added (SELECT + UPDATE, no INSERT/DELETE
 * — matching the read-where-it-writes rule the users.sql already documents). That grant, and the
 * db-suite proof of it, are out of this slice's scope and recorded in the report.
 */

/** Row shape mysql2 returns for an `UPDATE` — only the affected count matters here. */
interface UpdateResult {
  readonly affectedRows: number;
}

/**
 * Move every overdue `pending` invitation to `expired`, across all tenants, and return the count.
 *
 * Written out as a literal statement rather than reusing the API repository: the worker owns its
 * own DB access and must not import the Nest service or its Drizzle repository (the brief's rule,
 * and 18-REPOSITORY-STRUCTURE's layering). This file is one of the few permitted to spell SQL.
 */
export async function expireOverdueInvitations(tx: WorkerTransaction): Promise<number> {
  const result = await tx.query<UpdateResult>(
    `UPDATE invitations
        SET status = 'expired', updated_at = current_timestamp(3)
      WHERE status = 'pending'
        AND expires_at <= current_timestamp(3)`,
  );
  return result.affectedRows;
}

/** Bind {@link expireOverdueInvitations} to a worker pool as the sweep's store port. */
export function createInvitationSweepStore(database: WorkerDatabase): InvitationSweepStore {
  return {
    expireOverdue: () => database.transaction((tx) => expireOverdueInvitations(tx)),
  };
}
