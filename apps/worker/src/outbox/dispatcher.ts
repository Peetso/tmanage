import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import {
  OutboxTransactionLostError,
  claimReservedEvents,
  isRecoverableBatchError,
  listParkedEvents,
  markPublished,
  readOutboxBacklog,
  recordFailure,
  releaseReservedAttempts,
  reserveDueEvents,
  withSavepoint,
} from '../common/database/outbox-store.js';
import type {
  ClaimedOutboxEvent,
  OutboxBacklog,
  ParkedOutboxEvent,
} from '../common/database/outbox-store.js';
import { backoffDelayMs } from './backoff.js';

/**
 * The outbox dispatcher — PLAT-004's relay, `24-EVENT-CATALOG` §2 made runnable.
 *
 * ## The delivery loop, in one paragraph
 *
 * One batch is two transactions. The first **reserves**: it takes the oldest due,
 * unpublished, unparked ids with `FOR UPDATE SKIP LOCKED`, increments `attempts` on each,
 * and commits — so the attempt is durable *before* any handler runs. The second is the batch
 * proper: re-claim those ids under their own locks, run each type's handler inside a
 * savepoint, stamp `published_at` on success, and on failure roll the handler's writes back
 * and record the error and a backed-off `available_at`. Commit releases the locks.
 * At-least-once falls out of the ordering — a crash after a handler's side effect but
 * before commit rolls *everything* back, so the event is redelivered and the handler must
 * be idempotent, which is the contract §2 states and the db suite enforces on the one
 * consumer that exists.
 *
 * ## Why the reservation is separate
 *
 * Because the failure the relay could not previously survive is a handler that kills the
 * **process** rather than throwing: nothing rolls back to, the transaction dies with it, and
 * a single increment inside that transaction would die with it too. Committing the count
 * first is what turns "the same poison row re-claimed first at every restart, stalling every
 * notification and email org-wide" into "a row that parks after `OUTBOX_MAX_ATTEMPTS`
 * restarts like any other failure". See {@link reserveDueEvents} for the trade it makes.
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
  /** The attempt count including this one. Equal to `maxAttempts` means parked. */
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
  /**
   * The queue as it stands just after the batch committed — CRITICAL-2's measurement. Taken on
   * `database.read`, outside the batch transaction (IMPORTANT-D), so its full scan holds no row
   * locks and a timeout on it cannot abort the batch. It answers the only question an operator
   * has: is anything waiting, and for how long.
   */
  readonly backlog: OutboxBacklog;
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
  // Which event's own handler destroyed the batch transaction, if one did — the refund's
  // per-row cap. See the catch below.
  let transactionLostEventId: string | null = null;

  // Phase one, in a transaction of its own and committed before any handler runs: the
  // attempt is counted on durable storage, so a handler that kills the process costs its row
  // an attempt instead of costing it nothing. See `reserveDueEvents`.
  const reserved = await database.transaction((tx) =>
    reserveDueEvents(tx, { limit: options.batchSize, maxAttempts: options.maxAttempts }),
  );

  let batchResult: Omit<BatchReport, 'backlog' | 'effects' | 'effectFailures'>;
  try {
    batchResult = await database.transaction(async (tx) => {
      // Reset per attempt: should `transaction` ever re-run its callback, effects staged by an
      // attempt that did not commit must not survive into the one that did — and neither must
      // the blame for a transaction loss that attempt did not suffer.
      committedEffects = [];
      transactionLostEventId = null;
      const events = await claimReservedEvents(tx, reserved);

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
          //
          // Before rethrowing, remember *whose* handler did it: this event's attempt is the one
          // the whole-batch refund below must not give back, or a handler that deadlocks every
          // time never reaches the cap and never parks (IMPORTANT-1 of the x8 review).
          if (error instanceof OutboxTransactionLostError) {
            transactionLostEventId = event.id;
            throw error;
          }
          // Already incremented by the reservation — `attempts` counts this delivery.
          const attempts = event.attempts;
          const delay = backoffDelayMs(attempts, options.backoffBaseMs, options.backoffCapMs);
          await recordFailure(tx, event.id, messageOf(error), new Date(Date.now() + delay));
          failures.push({
            eventId: event.id,
            type: event.type,
            error: messageOf(error),
            attempts,
          });
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
  } catch (error) {
    // CRITICAL-B. The reservation already committed `attempts + 1` for `reserved`. A batch that
    // failed as a whole for a recoverable infrastructure fault — a deadlock, a lost
    // transaction, a statement timeout, a dropped connection — delivered nothing and did not
    // kill the process, so refund the speculative attempt: an ordinary deadlock then costs the
    // rows nothing, as it did before claim-time counting, instead of parking a whole batch of
    // never-delivered events at poll rate. A real process kill never reaches this catch, so its
    // rows keep the attempt CRITICAL-1 counted; an unrecognised error keeps it too, erring
    // toward parking a possible poison row rather than retrying it forever.
    //
    // IMPORTANT-1 of the x8 review — **the refund is capped per row at zero for the row that
    // caused the loss.** `withSavepoint` turns a handler's own `ER_LOCK_DEADLOCK` into
    // `OutboxTransactionLostError`, which is classified recoverable; refunding *every* reserved
    // row therefore refunded the culprit too, so a handler with a genuine lock-ordering bug
    // against the API repeated for ever — `attempts` back to its old value on every pass, the
    // row still first under `ORDER BY available_at, id`, nothing behind it draining. That is
    // CRITICAL-1's failure shape surviving for the deadlock class. Excluding the culprit spends
    // its attempt like any other failure, so it parks after `OUTBOX_MAX_ATTEMPTS` passes while
    // its blameless batch-mates keep the refund CRITICAL-B added.
    //
    // A blanket "refund at most N times, then spend the attempt" was considered and rejected:
    // for the *unattributable* recoverable failures (a pool exhausted, a connection dropped at
    // COMMIT, a lock-wait timeout on a statement of the relay's own) no row is at fault, and
    // spending their attempts during a long database outage would park a whole batch of
    // never-delivered events — which is exactly CRITICAL-B, re-opened. Those cases stay
    // refunded for ever by design; the loop backoff bounds the retry rate and backlog age is
    // what tells an operator the relay is not draining.
    const refundable = reserved.filter((id) => id !== transactionLostEventId);
    if (refundable.length > 0 && isRecoverableBatchError(error)) {
      try {
        await database.transaction((tx) => releaseReservedAttempts(tx, refundable));
      } catch {
        // Best effort. If even the refund cannot run, the rows keep an extra attempt, which is
        // the safe direction — they park rather than retry for ever. The original failure is
        // what the caller must see, so it is what we rethrow.
      }
    }
    throw error;
  }

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

  // IMPORTANT-D: the backlog aggregate is read here, on `database.read` and outside the batch
  // transaction, rather than inside it. The aggregate is a full scan of the unpublished tail
  // whose `CASE` defeats the claim index; taken inside the batch it held the batch's own
  // `FOR UPDATE` row locks for its whole duration and, worse, a `max_execution_time` kill on it
  // aborted the entire batch — feeding CRITICAL-B exactly when a backlog made the scan slowest.
  // A plain `SELECT` is a consistent non-locking read, so `--status` already reads it this way.
  const backlog = await database.read((tx) => readOutboxBacklog(tx, options.maxAttempts));

  return { ...batchResult, backlog, effects: committedEffects.length, effectFailures };
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
 * How long the loop waits after a **whole-batch** failure — CRITICAL-B's second half.
 *
 * A batch that throws whole (a deadlock, a lost connection, a pool exhausted) used to sleep
 * exactly one poll interval and try again, so a database that is down for a minute is hammered
 * twelve times a minute by every relay at once. This backs the retry off exponentially from the
 * poll interval, capped, with up to 25% jitter so relays that failed together do not retry in
 * lockstep. `consecutiveErrors` resets to 0 on the first batch that does not throw, so an
 * ordinary drained tick is unaffected — this only lengthens the gap while the failure persists.
 */
export function loopErrorDelayMs(
  consecutiveErrors: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  if (consecutiveErrors < 1) return 0;
  const exponent = Math.min(consecutiveErrors - 1, 30);
  const capped = Math.min(capMs, baseMs * 2 ** exponent);
  // Up to 25% jitter so relays that failed together do not retry in lockstep.
  return Math.round(capped * (1 + 0.25 * random()));
}

/**
 * The standalone-process shape: the batch above, repeated. An empty claim sleeps the full
 * interval; a full batch runs again immediately, so a backlog drains at transaction speed
 * rather than at poll speed. A batch that throws whole backs off — see {@link loopErrorDelayMs}.
 */
export async function runOutboxLoop(
  database: WorkerDatabase,
  handlers: OutboxHandlers,
  options: LoopOptions,
): Promise<void> {
  let consecutiveErrors = 0;
  while (!options.signal?.aborted) {
    let claimed = 0;
    let errored = false;
    try {
      const report = await runOutboxBatch(database, handlers, options);
      claimed = report.claimed;
      consecutiveErrors = 0;
      options.onBatch?.(report);
    } catch (error) {
      errored = true;
      consecutiveErrors += 1;
      options.onError?.(error);
    }

    if (options.signal?.aborted) return;
    if (errored) {
      // Back off the broken case rather than retrying at poll rate. The base is the poll
      // interval and the cap is the failure backoff cap, so no new knob is introduced.
      await sleep(
        loopErrorDelayMs(consecutiveErrors, options.pollIntervalMs, options.backoffCapMs),
        options.signal,
      );
    } else if (claimed < options.batchSize) {
      await sleep(options.pollIntervalMs, options.signal);
    }
  }
}
