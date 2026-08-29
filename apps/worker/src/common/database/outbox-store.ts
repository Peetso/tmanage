import type { WorkerTransaction } from './worker-database.js';

/**
 * The relay's own statements — claiming, publishing, failing, parking.
 *
 * All of them run without an `organization_id` predicate, and that is the relay's defining
 * property rather than an oversight: delivery order is `available_at, id` across the whole
 * table, so the oldest deliverable event goes first regardless of whose it is. The
 * per-event work the *consumers* do is scoped — see `lifecycle-store.ts`.
 */

/** One claimed row, as a consumer receives it. */
export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Parsed from `payload_json`. Ids and states only, by the producer's contract. */
  readonly payload: unknown;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  /** Failed deliveries so far — 0 on a row nothing has tried. */
  readonly attempts: number;
}

interface OutboxRow {
  readonly id: string;
  readonly organization_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: unknown;
  readonly correlation_id: string | null;
  readonly occurred_at: Date;
  readonly attempts: number;
}

/**
 * MySQL's JSON type hands mysql2 a parsed object; MariaDB's JSON is an alias for LONGTEXT
 * and arrives as a string. ADR-0002 records that both engines are real deployment targets,
 * so both shapes are handled rather than assumed away.
 */
function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export interface ClaimOptions {
  readonly limit: number;
  /** Rows at or past this many attempts are parked: visible, reported, never claimed. */
  readonly maxAttempts: number;
}

/**
 * Claim the due, unpublished, unparked events — oldest first by `(available_at, id)`.
 *
 * `FOR UPDATE SKIP LOCKED`: a second dispatcher running the same statement receives the
 * *next* batch rather than blocking on this one, which is what makes "runnable both as a
 * loop and as controlled batches" (50-BOOTSTRAP §3) safe to do concurrently. The locks
 * hold until the enclosing transaction commits, so a claimed event is either published,
 * failed forward, or — on a crash — released untouched for the next run. Supported by
 * MySQL 8.0 and MariaDB 10.6+, both inside the engines ADR-0002 names.
 */
export async function claimDueEvents(
  tx: WorkerTransaction,
  options: ClaimOptions,
): Promise<readonly ClaimedOutboxEvent[]> {
  const rows = await tx.query<readonly OutboxRow[]>(
    `SELECT id, organization_id, type, schema_version, aggregate_type, aggregate_id,
            payload_json, correlation_id, occurred_at, attempts
       FROM outbox_events
      WHERE published_at IS NULL
        AND available_at <= NOW(3)
        AND attempts < ?
      ORDER BY available_at, id
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [options.maxAttempts, options.limit],
  );

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    schemaVersion: Number(row.schema_version),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: parsePayload(row.payload_json),
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    attempts: Number(row.attempts),
  }));
}

/** Delivery succeeded — or the type had no consumer, which publishes to zero of them. */
export async function markPublished(tx: WorkerTransaction, eventId: string): Promise<void> {
  await tx.query(`UPDATE outbox_events SET published_at = NOW(3) WHERE id = ?`, [eventId]);
}

/**
 * Delivery failed: count the attempt, keep the shortest useful diagnosis, and push
 * `available_at` out so the retry backs off. When the incremented count reaches the cap
 * the row is parked by arithmetic — `claimDueEvents` filters `attempts < cap` — with no
 * flag column to keep in sync.
 */
export async function recordFailure(
  tx: WorkerTransaction,
  eventId: string,
  error: string,
  nextAvailableAt: Date,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_events
        SET attempts = attempts + 1, last_error = ?, available_at = ?
      WHERE id = ?`,
    // The column is VARCHAR(1000); truncated deliberately rather than by the driver.
    [error.slice(0, 1000), nextAvailableAt, eventId],
  );
}

export interface ParkedOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * The poison events — §2's dead-letter set, reported rather than silently skipped. An
 * operator replays one by resetting its `attempts`; nothing in the relay does that for
 * them, because a poison event that un-parks itself is a retry loop with extra steps.
 */
export async function listParkedEvents(
  tx: WorkerTransaction,
  maxAttempts: number,
  limit: number,
): Promise<readonly ParkedOutboxEvent[]> {
  interface ParkedRow {
    readonly id: string;
    readonly organization_id: string;
    readonly type: string;
    readonly attempts: number;
    readonly last_error: string | null;
  }
  const rows = await tx.query<readonly ParkedRow[]>(
    `SELECT id, organization_id, type, attempts, last_error
       FROM outbox_events
      WHERE published_at IS NULL AND attempts >= ?
      ORDER BY id
      LIMIT ?`,
    [maxAttempts, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    attempts: Number(row.attempts),
    lastError: row.last_error,
  }));
}

/**
 * Run one consumer inside a savepoint, so a failing handler rolls back *its own* writes —
 * a half-applied lifecycle rule is worse than an unapplied one — while the batch's other
 * events and the failure bookkeeping survive.
 */
export async function withSavepoint<T>(tx: WorkerTransaction, work: () => Promise<T>): Promise<T> {
  // A fixed name is safe: savepoints are per-connection, and one batch processes events
  // sequentially on one connection. Re-declaring the name replaces the previous savepoint.
  await tx.query('SAVEPOINT outbox_event');
  try {
    const result = await work();
    await tx.query('RELEASE SAVEPOINT outbox_event');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT outbox_event');
    throw error;
  }
}
