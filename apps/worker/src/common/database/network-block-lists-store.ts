import type { WorkerDatabase } from './worker-database.js';
import type { BlockListState, NetworkBlockListStore } from '../../jobs/network-block-lists.js';

/**
 * SEC-ALERTS item 7. The block-list refresh's statements over the worker's pool. `tmanage_worker`
 * holds SELECT, INSERT, UPDATE on `network_block_lists` and SELECT, INSERT, DELETE on
 * `network_block_ranges` (scripts/db/users.sql, 0405). Every bound is a bound JS value.
 */
const SQL = {
  lists: `SELECT list_key, active_version, fetched_at FROM network_block_lists`,
  insertRanges: (rows: number) =>
    `INSERT IGNORE INTO network_block_ranges (list_key, version, range_start, range_end) VALUES ${Array.from(
      { length: rows },
      () => '(?, ?, ?, ?)',
    ).join(', ')}`,
  activate: `UPDATE network_block_lists
    SET active_version = ?, range_count = ?, fetched_at = ?, last_attempt_at = ?, last_error = NULL
    WHERE list_key = ?`,
  deleteOtherVersions: `DELETE FROM network_block_ranges WHERE list_key = ? AND version <> ? LIMIT 5000`,
  deleteVersion: `DELETE FROM network_block_ranges WHERE list_key = ? AND version = ? LIMIT 5000`,
  failure: `UPDATE network_block_lists SET last_attempt_at = ?, last_error = ? WHERE list_key = ?`,
} as const;

interface ListRow {
  readonly list_key: string;
  readonly active_version: string | null;
  readonly fetched_at: Date | null;
}

async function deleteInBatches(
  database: WorkerDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  for (;;) {
    const removed = await database.transaction(async (tx) => {
      const result = await tx.query<{ affectedRows: number }>(sql, [...params]);
      return result.affectedRows;
    });
    if (removed < 5000) return;
  }
}

export function createNetworkBlockListStore(database: WorkerDatabase): NetworkBlockListStore {
  return {
    lists: () =>
      database.read(async (tx) => {
        const rows = await tx.query<ListRow[]>(SQL.lists, []);
        return rows.map((row): BlockListState => ({
          listKey: row.list_key,
          activeVersion: row.active_version,
          fetchedAt: row.fetched_at,
        }));
      }),
    writeRanges: async (listKey, version, ranges) => {
      if (ranges.length === 0) return;
      await database.transaction(async (tx) => {
        await tx.query(
          SQL.insertRanges(ranges.length),
          ranges.flatMap((range) => [listKey, version, range.start, range.end]),
        );
      });
    },
    activate: async (listKey, version, rangeCount, now) => {
      await database.transaction(async (tx) => {
        await tx.query(SQL.activate, [version, rangeCount, now, now, listKey]);
      });
      await deleteInBatches(database, SQL.deleteOtherVersions, [listKey, version]);
    },
    dropVersion: (listKey, version) =>
      deleteInBatches(database, SQL.deleteVersion, [listKey, version]),
    recordFailure: async (listKey, message, now) => {
      await database.transaction(async (tx) => {
        await tx.query(SQL.failure, [now, message, listKey]);
      });
    },
  };
}
