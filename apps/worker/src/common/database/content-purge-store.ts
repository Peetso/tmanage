import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import type {
  ContentPurgeStore,
  DuePurgeRow,
  PurgeDeleteResult,
} from '../../jobs/purge-sweeper.js';

/**
 * platform-admin v2 · PA-03 (0245): the content purge's statements, over the worker's own pool.
 *
 * `tmanage_worker` holds SELECT + DELETE on the content tables (scripts/db/users.sql, PA-03
 * block). The purge predicate is read on the server clock, never the worker host's. Table names
 * come only from the job's fixed list and are checked against a strict pattern before they are
 * spliced into SQL.
 */

interface DueRow {
  readonly organization_id: string;
  readonly id: string;
}

interface DeleteResult {
  readonly affectedRows: number;
}

const TABLE_NAME = /^[a-z_]+$/u;
const ROW_IS_REFERENCED = 1451;

function checkedTable(table: string): string {
  if (!TABLE_NAME.test(table)) throw new Error(`content purge: refusing table name ${table}`);
  return table;
}

function isRowReferenced(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { errno?: unknown }).errno === ROW_IS_REFERENCED ||
      (error as { code?: unknown }).code === 'ER_ROW_IS_REFERENCED_2')
  );
}

const PURGE_PREDICATE =
  'deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= current_timestamp(3)';

export async function listDueContent(
  tx: WorkerTransaction,
  table: string,
  limit: number,
): Promise<readonly DuePurgeRow[]> {
  const rows = await tx.query<readonly DueRow[]>(
    `SELECT organization_id, id FROM ${checkedTable(table)}
      WHERE ${PURGE_PREDICATE}
      ORDER BY purge_after, id
      LIMIT ${String(Math.max(1, Math.trunc(limit)))}`,
  );
  return rows.map((row) => ({ organizationId: row.organization_id, id: row.id }));
}

async function deleteRows(
  tx: WorkerTransaction,
  table: string,
  organizationId: string,
  ids: readonly string[],
): Promise<number> {
  const placeholders = ids.map(() => '?').join(', ');
  const result = await tx.query<DeleteResult>(
    `DELETE FROM ${checkedTable(table)}
      WHERE organization_id = ? AND id IN (${placeholders}) AND ${PURGE_PREDICATE}`,
    [organizationId, ...ids],
  );
  return result.affectedRows;
}

/**
 * Delete one organization's due rows in one statement; when a live row still references one of
 * them (errno 1451), fall back to one row at a time and count the referenced ones as blocked.
 */
export async function deleteDueContent(
  tx: WorkerTransaction,
  table: string,
  organizationId: string,
  ids: readonly string[],
): Promise<PurgeDeleteResult> {
  if (ids.length === 0) return { deleted: 0, blocked: 0 };
  try {
    return { deleted: await deleteRows(tx, table, organizationId, ids), blocked: 0 };
  } catch (error) {
    if (!isRowReferenced(error)) throw error;
  }
  let deleted = 0;
  let blocked = 0;
  for (const id of ids) {
    try {
      deleted += await deleteRows(tx, table, organizationId, [id]);
    } catch (error) {
      if (!isRowReferenced(error)) throw error;
      blocked += 1;
    }
  }
  return { deleted, blocked };
}

/** Bind the purge statements to a worker pool as the job's store port. */
export function createContentPurgeStore(database: WorkerDatabase): ContentPurgeStore {
  return {
    listDue: (table, limit) => database.read((tx) => listDueContent(tx, table, limit)),
    deleteDue: (table, organizationId, ids) =>
      database.transaction((tx) => deleteDueContent(tx, table, organizationId, ids)),
  };
}
