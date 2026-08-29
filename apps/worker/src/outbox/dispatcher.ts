import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import {
  claimDueEvents,
  listParkedEvents,
  markPublished,
  recordFailure,
  withSavepoint,
} from '../common/database/outbox-store.js';
import type { ClaimedOutboxEvent, ParkedOutboxEvent } from '../common/database/outbox-store.js';
import { backoffDelayMs } from './backoff.js';

/**
 * The outbox dispatcher — PLAT-004's relay, `24-EVENT-CATALOG` §2 made runnable.
 *
 * ## The delivery loop, in one paragraph
 *
 * One batch is one transaction: claim the oldest due, unpublished, unparked events with
 * `FOR UPDATE SKIP LOCKED`, run each type's handler inside a savepoint, stamp
 * `published_at` on success, and on failure roll the handler's writes back and record
 * `attempts + 1`, the error, and a backed-off `available_at`. Commit releases the locks.
 * At-least-once falls out of the ordering — a crash after a handler's side effect but
 * before commit rolls *everything* back, so the event is redelivered and the handler must
 * be idempotent, which is the contract §2 states and the db suite enforces on the one
 * consumer that exists.
 *
 * ## Two shapes, one function
 *
 * `50-BOOTSTRAP` §3 deploys the worker as a third always-on process **only if the plan
 * supports one reliably; otherwise run controlled worker batches**. So {@link runOutboxBatch}
 * is the unit — one claim, one transaction, a report — and {@link runOutboxLoop} is nothing
 * but that unit repeated with a pause, stoppable by `AbortSignal`. Batch mode is the deploy
 * story on the shared plan; the loop is the same code path, not a second implementation.
 *
 * ## Types with no handler are published, not held
 *
 * The catalog names consumers this repository has not built yet. An event whose type has
 * no registered handler is dispatched to zero consumers and marked published — delivery to
 * everyone who exists is delivery. Holding it "until a consumer arrives" would grow the
 * backlog without bound and starve the claim window, and a future consumer needs a
 * replay/projection mechanism anyway, not a queue that never drained.
 *
 * ## Parking
 *
 * A handler that fails `maxAttempts` times has its event parked: still in the table, never
 * claimed again (`attempts < maxAttempts` is in the claim predicate), and surfaced in
 * every report so the failure is an operator's page rather than a permanent retry hum.
 */

export type OutboxHandler = (event: ClaimedOutboxEvent, tx: WorkerTransaction) => Promise<void>;

export type OutboxHandlers = Readonly<Record<string, OutboxHandler>>;

export interface DispatcherOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

export interface EventFailure {
  readonly eventId: string;
  readonly type: string;
  /** `error.message` — never a payload, which the producer already keeps content-free. */
  readonly error: string;
  /** The attempt count after this failure. Equal to `maxAttempts` means parked. */
  readonly attempts: number;
}

export interface BatchReport {
  readonly claimed: number;
  /** Handled successfully, or dispatched to zero consumers — both are delivery. */
  readonly published: number;
  /** Of the published, how many had no registered handler. */
  readonly unhandled: number;
  readonly failed: number;
  readonly failures: readonly EventFailure[];
  /** Every parked event visible at the end of the batch, this batch's casualties included. */
  readonly parked: readonly ParkedOutboxEvent[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** One claim, one transaction, one report. The controlled-batch unit 50-BOOTSTRAP §3 asks for. */
export async function runOutboxBatch(
  database: WorkerDatabase,
  handlers: OutboxHandlers,
  options: DispatcherOptions,
): Promise<BatchReport> {
  return database.transaction(async (tx) => {
    const events = await claimDueEvents(tx, {
      limit: options.batchSize,
      maxAttempts: options.maxAttempts,
    });

    let published = 0;
    let unhandled = 0;
    const failures: EventFailure[] = [];

    for (const event of events) {
      const handler = handlers[event.type];

      if (!handler) {
        await markPublished(tx, event.id);
        published += 1;
        unhandled += 1;
        continue;
      }

      try {
        await withSavepoint(tx, () => handler(event, tx));
        await markPublished(tx, event.id);
        published += 1;
      } catch (error) {
        const attempts = event.attempts + 1;
        const delay = backoffDelayMs(attempts, options.backoffBaseMs, options.backoffCapMs);
        await recordFailure(tx, event.id, messageOf(error), new Date(Date.now() + delay));
        failures.push({ eventId: event.id, type: event.type, error: messageOf(error), attempts });
      }
    }

    // Reported from inside the same transaction, so the batch's own casualties are already
    // visible. The limit keeps a pathological backlog from turning a report into a dump.
    const parked = await listParkedEvents(tx, options.maxAttempts, 100);

    return {
      claimed: events.length,
      published,
      unhandled,
      failed: failures.length,
      failures,
      parked,
    };
  });
}

export interface LoopOptions extends DispatcherOptions {
  readonly pollIntervalMs: number;
  /** Abort to stop after the in-flight batch. The loop never abandons one mid-transaction. */
  readonly signal?: AbortSignal;
  /** Hears every batch report — the process's log line, a test's probe. */
  readonly onBatch?: (report: BatchReport) => void;
  /** Hears a batch that threw whole — connection loss, not a handler failure. */
  readonly onError?: (error: unknown) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * The standalone-process shape: the batch above, repeated. An empty claim sleeps the full
 * interval; a full batch runs again immediately, so a backlog drains at transaction speed
 * rather than at poll speed.
 */
export async function runOutboxLoop(
  database: WorkerDatabase,
  handlers: OutboxHandlers,
  options: LoopOptions,
): Promise<void> {
  while (!options.signal?.aborted) {
    let claimed = 0;
    try {
      const report = await runOutboxBatch(database, handlers, options);
      claimed = report.claimed;
      options.onBatch?.(report);
    } catch (error) {
      options.onError?.(error);
    }

    if (options.signal?.aborted) return;
    if (claimed < options.batchSize) {
      await sleep(options.pollIntervalMs, options.signal);
    }
  }
}
