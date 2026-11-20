import type { WorkerDatabase } from './worker-database.js';

/**
 * DC-3 / RT-3 — the SQL of the leader lease (`runtime_leases`, migration 0384). The state machine
 * that decides when to claim, when to trust a held lease and when to step down is
 * `src/runtime/leader-lease.ts`; this file only spells the three statements, so SQL stays under
 * `common/database/` (W-12).
 *
 * Why a lease row and not `GET_LOCK` on a dedicated connection (lane K report, D-1):
 *
 * - A named lock lives exactly as long as its connection ("released … when the connection
 *   terminates", MariaDB GET_LOCK). A pooled or idle connection that the host, `wait_timeout` or a
 *   network blip closes drops the lock **silently**: the old holder keeps working while another
 *   copy takes the lock. A row survives reconnects; a holder loses it only by not renewing.
 * - The holder of a named lock is visible only as a connection id; a row names the holder, so
 *   `/healthz/deep` and the logs can say which copy leads.
 * - A row costs no permanently held connection on a host with ~25 connections per user.
 *
 * The price is the takeover delay: after a crash the next copy waits for `expires_at`; after a
 * clean shutdown {@link releaseLease} expires the row at once.
 *
 * Every time is a JS `Date` bound by the caller, from the copy's own clock: never the server's
 * `CURRENT_TIMESTAMP` (the admin pool's clock is SYSTEM, not UTC). All copies of the app run on
 * one host, so they compare against one clock.
 */

/** The single statement surface the lease needs: one autocommit statement at a time. */
export type LeaseQuery = <T = unknown>(sql: string, params: readonly unknown[]) => Promise<T>;

/** What the row says right now. `null` holder = no row yet. */
export interface LeaseRow {
  readonly holder: string;
  readonly generation: number;
  readonly expiresAt: Date;
}

/** The outcome of one claim-or-renew statement. */
export type ClaimResult =
  | { readonly won: true; readonly generation: number }
  | { readonly won: false; readonly row: LeaseRow | null };

/**
 * Created once, expired at the epoch, so the first claim always wins. `INSERT IGNORE` reports 0
 * when the row exists, which is fine: the caller never reads its count.
 */
export const ENSURE_LEASE_SQL =
  'INSERT IGNORE INTO runtime_leases (name, holder, generation, expires_at) VALUES (?, ?, 0, ?)';

/**
 * Claim or renew in one statement. The WHERE is the whole mutual exclusion: the row matches only
 * for its current holder, or for anyone once it has expired, and InnoDB serialises two UPDATEs of
 * one row, so at most one copy matches while the lease is live.
 *
 * Single-table UPDATE assignments are evaluated left to right (MySQL 8.4 / MariaDB UPDATE), so
 * `generation` and `acquired_at` read the OLD `holder` before `holder` is assigned last.
 * mysql2 connects with CLIENT_FOUND_ROWS, so `affectedRows` is the number of rows MATCHED: 1 =
 * won, 0 = held by another live copy. (It is a plain UPDATE, not an upsert, so the
 * `upsert-affected-rows.guard.test.ts` rule does not apply.)
 */
export const CLAIM_LEASE_SQL =
  'UPDATE runtime_leases SET ' +
  'generation = IF(holder = ?, generation, generation + 1), ' +
  'acquired_at = IF(holder = ?, acquired_at, ?), ' +
  'renewed_at = ?, expires_at = ?, holder = ? ' +
  'WHERE name = ? AND (holder = ? OR expires_at < ?)';

export const READ_LEASE_SQL =
  'SELECT holder, generation, expires_at FROM runtime_leases WHERE name = ?';

/** A clean shutdown hands over at once: the row expires one millisecond before `now`. */
export const RELEASE_LEASE_SQL =
  'UPDATE runtime_leases SET expires_at = ? WHERE name = ? AND holder = ?';

function affectedRows(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const value = (result as { readonly affectedRows?: unknown }).affectedRows;
  return typeof value === 'number' ? value : 0;
}

function rowOf(rows: unknown): LeaseRow | null {
  if (!Array.isArray(rows)) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const expires = record['expires_at'];
  return {
    holder: String(record['holder'] ?? ''),
    generation: Number(record['generation'] ?? 0),
    expiresAt: expires instanceof Date ? expires : new Date(String(expires)),
  };
}

export interface LeaseStore {
  /** Claim (or renew, for the holder) until `expiresAt`. Throws only on a database error. */
  claim(name: string, holder: string, now: Date, expiresAt: Date): Promise<ClaimResult>;
  /** Expire this holder's row, if it still holds it. Throws only on a database error. */
  release(name: string, holder: string, now: Date): Promise<void>;
  end(): Promise<void>;
}

/** The store over any one-statement query function: the unit-tested core. */
export function createLeaseStore(query: LeaseQuery, end: () => Promise<void>): LeaseStore {
  return {
    async claim(name, holder, now, expiresAt) {
      await query(ENSURE_LEASE_SQL, [name, '', new Date(0)]);
      const result = await query(CLAIM_LEASE_SQL, [
        holder,
        holder,
        now,
        now,
        expiresAt,
        holder,
        name,
        holder,
        now,
      ]);
      const row = rowOf(await query(READ_LEASE_SQL, [name]));
      if (affectedRows(result) === 1 && row !== null && row.holder === holder) {
        return { won: true, generation: row.generation };
      }
      return { won: false, row };
    },
    async release(name, holder, now) {
      await query(RELEASE_LEASE_SQL, [new Date(now.getTime() - 1), name, holder]);
    },
    end,
  };
}

/**
 * The store on a one-connection pool of its own (ST-5 bulkhead): a long sweep never holds the
 * connection the renewal needs, and the statement timeout of the worker pool applies.
 */
export function createLeaseStoreDatabase(database: WorkerDatabase): LeaseStore {
  return createLeaseStore(
    <T>(sql: string, params: readonly unknown[]) => database.read((tx) => tx.query<T>(sql, params)),
    () => database.end(),
  );
}
