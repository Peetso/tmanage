import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import { insertNotification } from './notifications-store.js';
import type {
  DueDeferredRequest,
  ReopenNotice,
  RequestDeferSweepStore,
} from '../../jobs/request-defer-sweeper.js';

/**
 * A7 (0220): the defer sweep's statements, over the worker's own pool.
 *
 * `state = 'deferred' AND defer_until <= current_timestamp(3)`, read on the server so a request's
 * reopening never turns on the worker host's clock. Rows are locked (`FOR UPDATE`) and each update
 * repeats the `deferred` + version predicate, so a manager's "Reopen now" racing the sweep reopens
 * once. Grants already held by `tmanage_worker` (scripts/db/users.sql): SELECT + UPDATE on
 * `client_requests`, INSERT on `notifications`.
 */

interface DueRow {
  readonly id: string;
  readonly organization_id: string;
  readonly version: number | string;
  readonly reopen_reminder: number | boolean;
  readonly deferred_by_user_id: string | null;
}

interface UpdateResult {
  readonly affectedRows: number;
}

/** The longest batch one run reopens; the next run takes the rest. */
const SWEEP_BATCH = 500;

export async function reopenDueDeferredRequests(
  tx: WorkerTransaction,
  notice: ReopenNotice,
): Promise<readonly DueDeferredRequest[]> {
  const due = await tx.query<readonly DueRow[]>(
    `SELECT id, organization_id, version, reopen_reminder, deferred_by_user_id
       FROM client_requests
      WHERE state = 'deferred'
        AND defer_until IS NOT NULL
        AND defer_until <= current_timestamp(3)
      ORDER BY defer_until, id
      LIMIT ${String(SWEEP_BATCH)}
      FOR UPDATE`,
  );

  const reopened: DueDeferredRequest[] = [];
  for (const row of due) {
    const version = Number(row.version);
    const result = await tx.query<UpdateResult>(
      `UPDATE client_requests
          SET state = 'triage', defer_until = NULL, reopen_reminder = 0,
              deferred_by_user_id = NULL, version = version + 1,
              updated_at = current_timestamp(3)
        WHERE organization_id = ? AND id = ? AND version = ? AND state = 'deferred'`,
      [row.organization_id, row.id, version],
    );
    if (result.affectedRows !== 1) continue;

    const request: DueDeferredRequest = {
      id: row.id,
      organizationId: row.organization_id,
      version: version + 1,
      remindUserId:
        Boolean(Number(row.reopen_reminder)) && row.deferred_by_user_id !== null
          ? row.deferred_by_user_id
          : null,
    };
    if (request.remindUserId !== null) {
      await insertNotification(tx, {
        organizationId: request.organizationId,
        recipientUserId: request.remindUserId,
        type: notice.type,
        objectType: notice.objectType,
        objectId: request.id,
        dedupeKey: notice.dedupeKeyOf(request),
      });
    }
    reopened.push(request);
  }
  return reopened;
}

/** Bind {@link reopenDueDeferredRequests} to a worker pool as the sweep's store port. */
export function createRequestDeferSweepStore(database: WorkerDatabase): RequestDeferSweepStore {
  return {
    reopenDue: (notice) => database.transaction((tx) => reopenDueDeferredRequests(tx, notice)),
  };
}
