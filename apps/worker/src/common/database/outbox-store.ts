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
  /**
   * **Deliveries started, including this one** — never below 1 on a claimed row.
   *
   * The meaning changed deliberately (see {@link reserveDueEvents}): it used to be "failed
   * deliveries so far", counted only when a handler threw, which is exactly why a handler
   * that killed the process cost the row nothing and the queue stalled behind it forever.
   * The backoff arithmetic is unaffected — `backoffDelayMs` was always given the count
   * *after* the delivery being scheduled, and that is what this is.
   */
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
 * MySQL's JSON type hands mysql2 a parsed object, which is what this column returns. The
 * string branch is a tolerance for a driver or a column that hands back raw text — not an
 * engine difference, since MySQL is the only engine this runs against.
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
 * **Phase one of the claim: reserve the next events and count the attempt, durably.**
 *
 * Selects the due, unpublished, unparked events — oldest first by `(available_at, id)` —
 * with `FOR UPDATE SKIP LOCKED`, and increments `attempts` on every one of them before any
 * handler has run. It is meant to be called in a **transaction of its own**, committed
 * before the batch transaction opens, and that separation is the entire point.
 *
 * ## Why a second transaction rather than one extra statement
 *
 * `attempts` used to move only in {@link recordFailure}, which runs when a handler *throws*.
 * A handler that instead kills the process — OOM on a large payload, the host's OOM killer,
 * a `SIGKILL` mid-batch — never reaches that line. The server rolls the batch transaction
 * back, releases the locks, and the row returns with `attempts` unchanged: re-claimed first
 * on every restart, unable to ever reach the cap that parks it, with the whole queue behind
 * it. Incrementing inside the batch transaction fixes nothing, because a crash rolls that
 * increment back with everything else. The count has to be **committed before the handler
 * runs**, and that requires its own transaction.
 *
 * What that costs is stated plainly: `attempts` is now *deliveries started*, not deliveries
 * failed, so a crash between this commit and the batch's own — or a connection lost in
 * between — spends one attempt on a row nothing tried. With `OUTBOX_MAX_ATTEMPTS` at 8 that
 * is a cheap trade for a poison row that parks instead of stalling delivery org-wide.
 *
 * What it does not cost is delivery: `FOR UPDATE SKIP LOCKED` still keeps two relays off one
 * row here, and phase two re-checks `published_at IS NULL` under its own locks, so a row a
 * second relay published in the gap is simply not claimed rather than delivered twice.
 */
export async function reserveDueEvents(
  tx: WorkerTransaction,
  options: ClaimOptions,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { readonly id: string }[]>(
    `SELECT id
       FROM outbox_events
      WHERE published_at IS NULL
        AND available_at <= NOW(3)
        AND attempts < ?
      ORDER BY available_at, id
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [options.maxAttempts, options.limit],
  );

  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return ids;

  // No `last_error` and no `available_at` here: this records that a delivery *began*, and
  // the diagnosis belongs to whichever outcome follows. A row whose process dies keeps the
  // previous error and stays due, so the next start retries it immediately — one attempt
  // poorer each time, and parked once the cap is reached.
  await tx.query(
    `UPDATE outbox_events SET attempts = attempts + 1 WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return ids;
}

/** `?, ?, ?` for an `IN` list. Never interpolates a value — only the count of them. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * **Phase two of the claim: take the reserved rows into the batch transaction.**
 *
 * The locks this statement takes hold until the batch commits, so a claimed event is either
 * published, failed forward, or — on a crash — released for the next run, now one attempt
 * poorer. `published_at IS NULL` is re-checked because phase one's locks were released at
 * its own commit; a row another relay drained in that gap is skipped rather than redelivered.
 *
 * There is deliberately **no `attempts < maxAttempts` predicate**. Phase one has already
 * incremented, so the row that just reached the cap would be filtered out here and would
 * never get the delivery its final attempt was counted for.
 */
export async function claimReservedEvents(
  tx: WorkerTransaction,
  ids: readonly string[],
): Promise<readonly ClaimedOutboxEvent[]> {
  if (ids.length === 0) return [];
  const rows = await tx.query<readonly OutboxRow[]>(
    `SELECT id, organization_id, type, schema_version, aggregate_type, aggregate_id,
            payload_json, correlation_id, occurred_at, attempts
       FROM outbox_events
      WHERE id IN (${placeholders(ids.length)})
        AND published_at IS NULL
      ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED`,
    [...ids],
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
 * Delivery failed: keep the shortest useful diagnosis and push `available_at` out so the
 * retry backs off.
 *
 * It no longer touches `attempts` — {@link reserveDueEvents} counted the attempt before the
 * handler ran, which is what makes a process-killing handler cost the row something. Parking
 * is still arithmetic: once the reserved count reaches the cap the claim's `attempts < cap`
 * excludes the row, with no flag column to keep in sync.
 */
export async function recordFailure(
  tx: WorkerTransaction,
  eventId: string,
  error: string,
  nextAvailableAt: Date,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_events
        SET last_error = ?, available_at = ?
      WHERE id = ?`,
    // The column is VARCHAR(1000); truncated deliberately rather than by the driver.
    [error.slice(0, 1000), nextAvailableAt, eventId],
  );
}

/**
 * The one measurement that tells a stopped relay from an idle one — CRITICAL-2's fix.
 *
 * A healthy worker with nothing to do and a worker that died three days ago produce exactly
 * the same logs (none), the same exit code from `relay:once` (0), and the same everything
 * else. What separates them is **how old the oldest undelivered event is**: a number that
 * stays near zero while the relay drains and grows without bound the moment it stops,
 * whatever the reason — a crash loop, a killed process, an exhausted pool, a cron entry
 * someone removed, a `WORKER_DATABASE_URL` that stopped resolving.
 *
 * Read on the **worker's** credential rather than the API's on purpose: `tmanage_worker`
 * already holds SELECT on `outbox_events` (`scripts/db/users.sql`), so this needs no new
 * grant, and the process being measured is the one that answers for it.
 *
 * Parked rows are counted but excluded from the age: they are a separate, already-reported
 * condition, and letting one park permanently would otherwise pin the age at "growing
 * forever" and drown the signal this exists to give.
 */
export interface OutboxBacklog {
  /** Unpublished and not parked — the work the relay still owes. */
  readonly pending: number;
  /** Unpublished and at or past the attempt cap — never claimed again without an operator. */
  readonly parked: number;
  /**
   * Seconds between now and the oldest pending row's `available_at`, floored at 0.
   * `null` when nothing is pending, which is the drained state and not a missing reading.
   */
  readonly oldestPendingSeconds: number | null;
}

export async function readOutboxBacklog(
  tx: WorkerTransaction,
  maxAttempts: number,
): Promise<OutboxBacklog> {
  interface BacklogRow {
    readonly pending: unknown;
    readonly parked: unknown;
    readonly oldest_pending_seconds: unknown;
  }
  const rows = await tx.query<readonly BacklogRow[]>(
    `SELECT SUM(CASE WHEN attempts <  ? THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS parked,
            TIMESTAMPDIFF(
              SECOND,
              MIN(CASE WHEN attempts < ? THEN available_at END),
              NOW(3)
            ) AS oldest_pending_seconds
       FROM outbox_events
      WHERE published_at IS NULL`,
    [maxAttempts, maxAttempts, maxAttempts],
  );

  const row = rows[0];
  const oldest = row === undefined ? null : row.oldest_pending_seconds;
  return {
    pending: row === undefined ? 0 : Number(row.pending ?? 0),
    parked: row === undefined ? 0 : Number(row.parked ?? 0),
    // A pending row backed off into the future reads negative; 0 is the honest answer for
    // "nothing is overdue", and the `null` above is reserved for "nothing is pending".
    oldestPendingSeconds:
      oldest === null || oldest === undefined ? null : Math.max(0, Number(oldest)),
  };
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
 * Thrown when the enclosing **transaction** is gone, not merely the handler's own writes.
 *
 * The distinction is the whole reason this class exists. `withSavepoint` is built on the
 * assumption that a handler's failure is statement-local and the batch continues; InnoDB
 * breaks that assumption in one specific way. A deadlock victim (`ER_LOCK_DEADLOCK`, 1213)
 * has its **entire transaction** rolled back by the server, and every savepoint in it
 * destroyed. Every write the batch made before that point — including the `published_at`
 * stamps of events already handled — is gone, and the connection is sitting outside any
 * transaction.
 *
 * Caught as an ordinary handler error, that looks like "one event failed, carry on": the
 * dispatcher would record a failure, commit nothing of substance, report success for the
 * earlier events, and — since after-commit effects are promoted per event — **send the mail
 * for events whose publication was destroyed**, which the next batch would then re-claim and
 * mail again. A duplicate email cannot be un-sent, so the dispatcher must be able to tell the
 * two cases apart. It does so by this type.
 */
export class OutboxTransactionLostError extends Error {
  /** The driver error that revealed it, kept for the operator's log and nothing else. */
  readonly driverError: unknown;

  constructor(driverError: unknown) {
    super('the batch transaction was rolled back by the server');
    this.name = 'OutboxTransactionLostError';
    this.driverError = driverError;
  }
}

/** InnoDB's deadlock victim. Always rolls the whole transaction back — never one statement. */
const ER_LOCK_DEADLOCK = 1213;

function isDeadlock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { errno?: unknown }).errno;
  return code === ER_LOCK_DEADLOCK;
}

/**
 * Run one consumer inside a savepoint, so a failing handler rolls back *its own* writes —
 * a half-applied lifecycle rule is worse than an unapplied one — while the batch's other
 * events and the failure bookkeeping survive.
 *
 * Two escapes from that rule, both raising {@link OutboxTransactionLostError}: the handler
 * error is a deadlock, or the `ROLLBACK TO SAVEPOINT` itself fails — which can only mean the
 * savepoint no longer exists, which can only mean the transaction no longer exists. The
 * second is the catch-all: whatever destroys a transaction, it takes the savepoints with it,
 * and this statement is where that becomes observable.
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
    if (isDeadlock(error)) throw new OutboxTransactionLostError(error);
    try {
      await tx.query('ROLLBACK TO SAVEPOINT outbox_event');
    } catch (rollbackError) {
      throw new OutboxTransactionLostError(rollbackError);
    }
    throw error;
  }
}
