import type { WorkerDatabase } from './worker-database.js';
import type {
  ClaimedRotation,
  RotationCounts,
  RotationStore,
  RotationTarget,
  SecretRow,
} from '../../jobs/field-cipher-rotation.js';

/**
 * 56-02: the rotation job's statements, over the worker's pool. `tmanage_worker` holds SELECT,
 * INSERT, UPDATE on `key_rotations` and SELECT, UPDATE on the target tables (scripts/db/users.sql).
 * Table and column names (including `versionColumn` and the `owner` expression) come only from the
 * closed `ROTATION_TARGETS` map, never from a row.
 */

interface WriteResult {
  readonly affectedRows: number;
}
interface RotationRow {
  readonly id: string;
  readonly purpose: string;
  readonly to_key_id: string;
  readonly last_row_id: string | null;
  readonly rows_done: number;
  readonly rows_skipped: number;
  readonly rows_failed: number;
}

const CLAIM = `SELECT id, purpose, to_key_id, last_row_id, rows_done, rows_skipped, rows_failed
  FROM key_rotations
 WHERE status = 'queued'
    OR (status = 'running' AND heartbeat_at < current_timestamp(3) - interval ? second)
 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
const MARK_RUNNING = `UPDATE key_rotations
   SET status = 'running', started_at = coalesce(started_at, current_timestamp(3)),
       heartbeat_at = current_timestamp(3)
 WHERE id = ?`;
const PROGRESS = `UPDATE key_rotations
   SET last_row_id = ?, rows_done = ?, rows_skipped = ?, rows_failed = ?,
       heartbeat_at = current_timestamp(3)
 WHERE id = ? AND status = 'running'`;
const FINISH = `UPDATE key_rotations
   SET status = ?, error = ?, finished_at = current_timestamp(3)
 WHERE id = ? AND status = 'running'`;
const PAUSE = `UPDATE key_rotations SET status = 'queued' WHERE id = ? AND status = 'running'`;

export function createRotationStore(database: WorkerDatabase): RotationStore {
  return {
    claimNext: (staleMs) =>
      database.transaction(async (tx) => {
        const rows = await tx.query<readonly RotationRow[]>(CLAIM, [Math.ceil(staleMs / 1000)]);
        const row = rows[0];
        if (row === undefined) return null;
        await tx.query(MARK_RUNNING, [row.id]);
        const claimed: ClaimedRotation = {
          id: row.id,
          purpose: row.purpose,
          toKeyId: row.to_key_id,
          lastRowId: row.last_row_id,
          counts: {
            done: Number(row.rows_done),
            skipped: Number(row.rows_skipped),
            failed: Number(row.rows_failed),
          },
        };
        return claimed;
      }),

    countTotal: (rotationId, target) =>
      database.transaction(async (tx) => {
        await tx.query(
          `UPDATE key_rotations SET rows_total =
             (SELECT count(*) FROM ${target.table} WHERE ${target.column} IS NOT NULL)
           WHERE id = ?`,
          [rotationId],
        );
      }),

    readBatch: (target: RotationTarget, afterId, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { id: string; owner_id: string; value: string }[]>(
          `SELECT id, ${target.owner} AS owner_id, ${target.column} AS value
             FROM ${target.table}
            WHERE ${target.column} IS NOT NULL AND id > ?
            ORDER BY id LIMIT ${Math.trunc(limit)}`,
          [afterId ?? ''],
        );
        return rows.map((r): SecretRow => ({ id: r.id, ownerId: r.owner_id, value: r.value }));
      }),

    writeValue: (target, id, from, to, toKeyId) =>
      database.transaction(async (tx) => {
        // R23-c: a versioned target (org_secrets.key_version) records the key in the same CAS.
        const result =
          target.versionColumn === undefined
            ? await tx.query<WriteResult>(
                `UPDATE ${target.table} SET ${target.column} = ? WHERE id = ? AND ${target.column} = ?`,
                [to, id, from],
              )
            : await tx.query<WriteResult>(
                `UPDATE ${target.table} SET ${target.column} = ?, ${target.versionColumn} = ? WHERE id = ? AND ${target.column} = ?`,
                [to, toKeyId, id, from],
              );
        return result.affectedRows === 1;
      }),

    saveProgress: (rotationId, lastRowId, counts: RotationCounts) =>
      database.transaction(async (tx) => {
        await tx.query(PROGRESS, [
          lastRowId,
          counts.done,
          counts.skipped,
          counts.failed,
          rotationId,
        ]);
      }),

    finish: (rotationId, status, error) =>
      database.transaction(async (tx) => {
        await tx.query(FINISH, [status, error, rotationId]);
      }),

    pause: (rotationId) =>
      database.transaction(async (tx) => {
        await tx.query(PAUSE, [rotationId]);
      }),
  };
}

/** Queue a rotation (the worker CLI; the API's POST /v1/platform/keys/rotate does the same). */
export async function enqueueRotation(
  database: WorkerDatabase,
  input: { id: string; purpose: string; toKeyId: string; requestedBy: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO key_rotations (id, purpose, to_key_id, requested_by) VALUES (?, ?, ?, ?)`,
      [input.id, input.purpose, input.toKeyId, input.requestedBy],
    );
  });
}
