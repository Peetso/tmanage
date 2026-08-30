import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import {
  OutboxTransactionLostError,
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
 *
 * ## After-commit effects, and why they exist
 *
 * A handler runs *inside* the batch transaction, which is right for everything that writes
 * rows and wrong for everything that talks to a third party. Sending an email from a
 * handler would hold an open database transaction — and the claim's row locks — across an
 * SMTP round trip to a host this process does not control. The API already refuses to do
 * that: `InvitationsService` sends **after** its transaction commits.
 *
 * So a handler is handed {@link OutboxEffects} and may register work to run once the batch
 * has committed. The rules are exactly the ones that make the guarantee statable:
 *
 * - **An effect registered by a handler whose savepoint rolled back never runs.** Staging
 *   is per event; a failed event's staged effects are discarded with its writes.
 * - **An effect registered by a batch that never committed never runs.** A transaction that
 *   throws whole takes that attempt's effects with it. This is why an
 *   {@link OutboxTransactionLostError} — the server rolling the whole transaction back under
 *   the batch, which destroys every savepoint *and* every `published_at` already stamped —
 *   aborts the batch instead of being recorded as one event's failure. Treated as a handler
 *   error it would publish nothing and still send the mail for the events it had promoted,
 *   which the next batch would re-claim and mail a second time.
 * - **Effects are not interruptible.** Once the loop below starts, it runs to the end; an
 *   `AbortSignal` is not consulted between effects. The bound on how long that can take is
 *   therefore the transport's own timeouts, which is why `SmtpMailer` sets explicit ones
 *   rather than leaving a black-holed host to nodemailer's defaults.
 * - **An effect that throws cannot be retried.** By the time it runs, `published_at` is
 *   committed and the event will never be claimed again. That is deliberate: retrying would
 *   mean re-running the handler, and a handler that has already written its rows must not
 *   write them twice. So an effect failure is **reported and logged, and the side effect is
 *   lost** — at-most-once, on the far side of a guarantee that is at-least-once up to the
 *   commit. For mail that is the right trade: a client who does not receive an email still
 *   has the in-app notification, which `35-NOTIFICATION-AND-EMAIL-COPY` §1 calls canonical,
 *   and a duplicate email cannot be un-sent.
 */

/**
 * Work a handler defers until the batch has committed — see the module doc. It takes no
 * transaction on purpose: there is none open when it runs, and a closure that captured `tx`
 * would be writing through a released connection.
 */
export type OutboxEffect = () => Promise<void>;

/** What a handler is given to register {@link OutboxEffect}s with. */
export interface OutboxEffects {
  afterCommit(effect: OutboxEffect): void;
}

export type OutboxHandler = (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
  effects: OutboxEffects,
) => Promise<void>;

export type OutboxHandlers = Readonly<Record<string, OutboxHandler>>;

export interface DispatcherOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

/** An after-commit effect that threw. Its event is already published — see the module doc. */
export interface EffectFailure {
  readonly eventId: string;
  readonly type: string;
  /** `error.message` — the driver's words, which may name a recipient. Operator log only. */
  readonly error: string;
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
  /** After-commit effects attempted once the batch committed — not necessarily successful. */
  readonly effects: number;
  /** Of those, the ones that threw. Unretryable by construction — see the module doc. */
  readonly effectFailures: readonly EffectFailure[];
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
  interface StagedEffect {
    readonly eventId: string;
    readonly type: string;
    readonly run: OutboxEffect;
  }
  let committedEffects: StagedEffect[] = [];

  const report = await database.transaction(async (tx) => {
    // Reset per attempt: should `transaction` ever re-run its callback, effects staged by an
    // attempt that did not commit must not survive into the one that did.
    committedEffects = [];
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

      // Staged per event and promoted only once the savepoint has held: an effect belonging
      // to a handler whose writes were rolled back must not run.
      const staged: OutboxEffect[] = [];
      const effects: OutboxEffects = {
        afterCommit: (effect) => {
          staged.push(effect);
        },
      };

      try {
        await withSavepoint(tx, () => handler(event, tx, effects));
        await markPublished(tx, event.id);
        published += 1;
        for (const run of staged) {
          committedEffects.push({ eventId: event.id, type: event.type, run });
        }
      } catch (error) {
        // Not this event's failure — the whole transaction is gone, so `recordFailure` would
        // write into a fresh implicit one and the earlier events' `published_at` stamps are
        // already destroyed. Rethrowing discards every staged effect with them, and the
        // batch is retried from the claim.
        if (error instanceof OutboxTransactionLostError) throw error;
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

  // Past this line the batch has committed and every `published_at` is durable. Nothing here
  // can un-publish an event, so nothing here throws: an effect's failure becomes data in the
  // report, which is what `main.ts` logs and what a suite asserts on.
  const effectFailures: EffectFailure[] = [];
  for (const effect of committedEffects) {
    try {
      await effect.run();
    } catch (error) {
      effectFailures.push({ eventId: effect.eventId, type: effect.type, error: messageOf(error) });
    }
  }

  return { ...report, effects: committedEffects.length, effectFailures };
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
