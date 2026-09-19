import { describe, expect, it } from 'vitest';
import { loopErrorDelayMs, runOutboxBatch } from './dispatcher.js';
import type { OutboxHandlers } from './dispatcher.js';
import { OutboxTransactionLostError, unparkEvents } from '../common/database/outbox-store.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/**
 * CRITICAL-1 of the worker/outbox audit: **a handler that kills the process must still cost
 * its row an attempt.**
 *
 * > `attempts` is only ever incremented by `recordFailure`, which runs when a handler
 * > *throws*. A handler that instead kills the process — OOM on a large payload, an
 * > unhandled rejection in a nested await, the host's OOM killer, a `SIGKILL` mid-batch —
 * > never reaches that line. The server rolls the transaction back, releases the locks, and
 * > the row returns to the table with `attempts` unchanged. [...] The queue does not drain
 * > past R.
 *
 * The fake below is a queue, not a stub: it holds rows with real `attempts`, `published_at`
 * and `available_at` columns and applies the claim's predicates against them, so "the same
 * row is claimed again at the next start and eventually parks" is something the test
 * observes rather than asserts about a mock call.
 *
 * A process kill is modelled the only way a unit test can model one — the batch transaction
 * rejects and **nothing rolls the reservation back**, because on a real kill there is no
 * process left to roll anything back and the reservation transaction had already committed.
 * That the reservation really does commit first against a real server is the job of
 * `apps/api/test/plat-004-claim-attempts.db.test.ts`, which this suite cannot stand in for.
 */

interface Row {
  id: string;
  type: string;
  attempts: number;
  publishedAt: Date | null;
  occurredAt: Date;
  availableAt: Date;
  lastError: string | null;
}

const OPTIONS = { batchSize: 10, maxAttempts: 3, backoffBaseMs: 1000, backoffCapMs: 60_000 };

/**
 * A queue that behaves like the table: the reservation increments, publication stamps,
 * failure backs off, and every claim predicate (`published_at IS NULL`,
 * `available_at <= now`, `attempts < cap`) is applied to real values.
 */
class FakeQueue {
  readonly rows: Row[] = [];

  add(id: string, type: string, availableSecondsAgo = 1): void {
    // The event occurred when it became due; a retry would later push availableAt forward, but a
    // freshly added row has occurred_at == available_at, so the backlog age reads availableSecondsAgo.
    const at = new Date(Date.now() - availableSecondsAgo * 1000);
    this.rows.push({
      id,
      type,
      attempts: 0,
      publishedAt: null,
      occurredAt: at,
      availableAt: at,
      lastError: null,
    });
  }

  row(id: string): Row {
    const found = this.rows.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  }

  private readonly tx: WorkerTransaction = {
    query: <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      const text = sql.trim().toUpperCase();
      const locking = text.includes('FOR UPDATE');

      // `relay:unpark`'s selection: the parked rows it is about to reset, locked. Told from
      // phase one by `last_error` — only the parked shapes read it.
      if (locking && text.includes('LAST_ERROR')) {
        const parked = this.rows.filter(
          (row) =>
            row.publishedAt === null &&
            row.attempts >= Number(params[0]) &&
            (params.length < 2 || row.id === params[1]),
        );
        return Promise.resolve(
          parked.map((row) => ({
            id: row.id,
            organization_id: 'org-1',
            type: row.type,
            attempts: row.attempts,
            last_error: row.lastError,
          })) as T,
        );
      }

      // `relay:unpark`'s reset: back to pending, due now, diagnosis cleared.
      if (text.startsWith('UPDATE') && text.includes('ATTEMPTS = 0')) {
        for (const id of params) {
          const row = this.row(String(id));
          row.attempts = 0;
          row.availableAt = new Date(Date.now() - 1);
          row.lastError = null;
        }
        return Promise.resolve({ affectedRows: params.length } as T);
      }

      // Phase two: re-claim the reserved ids that are still unpublished. Distinguished from
      // phase one by the columns — only the full claim reads the payload.
      if (locking && text.includes('PAYLOAD_JSON')) {
        const claimed = this.rows
          .filter((row) => params.includes(row.id) && row.publishedAt === null)
          .map((row) => ({
            id: row.id,
            organization_id: 'org-1',
            type: row.type,
            schema_version: 1,
            aggregate_type: 'work_item',
            aggregate_id: 'w-1',
            payload_json: '{}',
            correlation_id: null,
            occurred_at: new Date(0),
            attempts: row.attempts,
          }));
        return Promise.resolve(claimed as T);
      }

      // Phase one's SELECT: the due, unpublished, unparked ids, oldest first.
      if (locking) {
        const due = this.rows
          .filter(
            (row) =>
              row.publishedAt === null &&
              row.availableAt.getTime() <= Date.now() &&
              row.attempts < Number(params[0]),
          )
          .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
          .slice(0, Number(params[1]))
          .map((row) => ({ id: row.id }));
        return Promise.resolve(due as T);
      }

      // Phase one's UPDATE: count the attempt, before any handler runs.
      if (text.startsWith('UPDATE') && text.includes('ATTEMPTS = ATTEMPTS + 1')) {
        for (const id of params) this.row(String(id)).attempts += 1;
        return Promise.resolve({ affectedRows: params.length } as T);
      }

      // CRITICAL-B's compensation: refund the reserved attempt on a recoverable whole-batch
      // failure, but only on a row still unpublished and never below zero.
      if (text.startsWith('UPDATE') && text.includes('ATTEMPTS = ATTEMPTS - 1')) {
        for (const id of params) {
          const row = this.row(String(id));
          if (row.publishedAt === null && row.attempts > 0) row.attempts -= 1;
        }
        return Promise.resolve({ affectedRows: params.length } as T);
      }

      if (text.startsWith('UPDATE') && text.includes('PUBLISHED_AT')) {
        this.row(String(params[0])).publishedAt = new Date();
        return Promise.resolve({ affectedRows: 1 } as T);
      }

      if (text.startsWith('UPDATE') && text.includes('LAST_ERROR')) {
        const row = this.row(String(params[2]));
        row.lastError = String(params[0]);
        row.availableAt = params[1] as Date;
        return Promise.resolve({ affectedRows: 1 } as T);
      }

      // The backlog read: the raw unpublished rows, aggregated in TypeScript by `computeBacklog`.
      if (text.includes('NOW_AT')) {
        const now = new Date();
        return Promise.resolve(
          this.rows
            .filter((row) => row.publishedAt === null)
            .map((row) => ({
              attempts: row.attempts,
              occurred_at: row.occurredAt,
              available_at: row.availableAt,
              now_at: now,
            })) as T,
        );
      }

      // The parked listing.
      if (text.startsWith('SELECT ID,')) {
        const parked = this.rows
          .filter((row) => row.publishedAt === null && row.attempts >= Number(params[0]))
          .map((row) => ({
            id: row.id,
            organization_id: 'org-1',
            type: row.type,
            attempts: row.attempts,
            last_error: row.lastError,
          }));
        return Promise.resolve(parked as T);
      }

      // SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT.
      return Promise.resolve(undefined as T);
    },
  };

  readonly database: WorkerDatabase = {
    transaction: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> => work(this.tx),
    read: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> => work(this.tx),
    end: () => Promise.resolve(),
  };

  /**
   * The same queue, but the **batch** transaction dies without undoing anything — a killed
   * process, not a rolled-back one. The reservation transaction still commits.
   */
  killedDuringBatch(): WorkerDatabase {
    let call = 0;
    return {
      ...this.database,
      transaction: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> => {
        call += 1;
        if (call === 1) return this.database.transaction(work);
        return Promise.reject(new Error('[simulated] process killed mid-batch'));
      },
    };
  }

  /**
   * The reservation (transaction 1) commits, the **batch** (transaction 2) rejects with the
   * given error, and any later transaction — CRITICAL-B's compensation — runs normally against
   * the queue. This is the process-*survived* failure: a deadlock, a lost connection, a
   * statement timeout, unlike {@link killedDuringBatch} where nothing after the kill can run.
   */
  rejectedBatch(error: unknown): WorkerDatabase {
    let call = 0;
    return {
      ...this.database,
      transaction: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> => {
        call += 1;
        if (call === 2) return Promise.reject(error);
        return this.database.transaction(work);
      },
    };
  }
}

describe('claim-time attempt bookkeeping (CRITICAL-1)', () => {
  it('counts an attempt before the handler runs, so a killed process costs the row one', async () => {
    const queue = new FakeQueue();
    queue.add('poison', 'poison.v1');

    await expect(runOutboxBatch(queue.killedDuringBatch(), {}, OPTIONS)).rejects.toThrow(
      'process killed mid-batch',
    );

    // The whole finding in one assertion: before the fix this stayed 0, for ever.
    expect(queue.row('poison').attempts).toBe(1);
    expect(queue.row('poison').publishedAt).toBeNull();
  });

  it('parks a row that kills the process on every restart, instead of stalling the queue', async () => {
    const queue = new FakeQueue();
    queue.add('poison', 'poison.v1');

    for (let restart = 0; restart < OPTIONS.maxAttempts; restart += 1) {
      await expect(runOutboxBatch(queue.killedDuringBatch(), {}, OPTIONS)).rejects.toThrow(
        'killed mid-batch',
      );
    }
    expect(queue.row('poison').attempts).toBe(OPTIONS.maxAttempts);

    // Everything that arrives behind it now drains, which is the property the audit says was
    // lost org-wide: "every notification, every client email, every work-item lifecycle
    // transition, org-wide — stops".
    queue.add('behind', 'plain.v1');
    const report = await runOutboxBatch(
      queue.database,
      { 'plain.v1': () => Promise.resolve() },
      OPTIONS,
    );

    expect(report.claimed).toBe(1);
    expect(report.published).toBe(1);
    expect(queue.row('behind').publishedAt).not.toBeNull();
    expect(queue.row('poison').publishedAt).toBeNull();
    expect(report.parked.map((event) => event.id)).toContain('poison');
  });

  it('spends the attempt on every row the dead batch had reserved — the trade, made visible', async () => {
    // Not a defect to be quietly fixed: a crash costs an attempt to every row the batch had
    // already reserved, including ones whose handler never ran. That is the price of counting
    // before delivering, it is bounded by OUTBOX_BATCH_SIZE, and it is strictly better than
    // the alternative this replaces — a stall with no attempt counted and no signal at all.
    // A change that makes this assertion fail has changed the trade and owes the report a note.
    const queue = new FakeQueue();
    queue.add('first', 'poison.v1', 60);
    queue.add('innocent', 'plain.v1', 30);

    await expect(runOutboxBatch(queue.killedDuringBatch(), {}, OPTIONS)).rejects.toThrow(
      'killed mid-batch',
    );

    expect(queue.row('first').attempts).toBe(1);
    expect(queue.row('innocent').attempts).toBe(1);
  });

  it('does not double-count: a throwing handler still spends exactly one attempt', async () => {
    const queue = new FakeQueue();
    queue.add('thrower', 'throws.v1');
    const handlers: OutboxHandlers = {
      'throws.v1': () => Promise.reject(new Error('an ordinary handler failure')),
    };

    const report = await runOutboxBatch(queue.database, handlers, OPTIONS);

    expect(report.failed).toBe(1);
    expect(report.failures[0]).toMatchObject({ eventId: 'thrower', attempts: 1 });
    expect(queue.row('thrower').attempts).toBe(1);
    expect(queue.row('thrower').lastError).toContain('an ordinary handler failure');
    // Backed off rather than immediately due again.
    expect(queue.row('thrower').availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('parks a throwing handler at the cap, with the failure counted once per attempt', async () => {
    const queue = new FakeQueue();
    queue.add('thrower', 'throws.v1');
    const handlers: OutboxHandlers = {
      'throws.v1': () => Promise.reject(new Error('an ordinary handler failure')),
    };

    for (let attempt = 1; attempt <= OPTIONS.maxAttempts; attempt += 1) {
      queue.row('thrower').availableAt = new Date(Date.now() - 1000);
      const report = await runOutboxBatch(queue.database, handlers, OPTIONS);
      expect(report.failures[0]?.attempts).toBe(attempt);
    }

    queue.row('thrower').availableAt = new Date(Date.now() - 1000);
    const after = await runOutboxBatch(queue.database, handlers, OPTIONS);
    expect(after.claimed).toBe(0);
    expect(after.parked.map((event) => event.id)).toContain('thrower');
    expect(queue.row('thrower').attempts).toBe(OPTIONS.maxAttempts);
  });

  it('publishes a successful event once and never re-claims it', async () => {
    const queue = new FakeQueue();
    queue.add('good', 'good.v1');
    const handlers: OutboxHandlers = { 'good.v1': () => Promise.resolve() };

    const first = await runOutboxBatch(queue.database, handlers, OPTIONS);
    const second = await runOutboxBatch(queue.database, handlers, OPTIONS);

    expect(first.published).toBe(1);
    expect(second.claimed).toBe(0);
    expect(queue.row('good').attempts).toBe(1);
  });

  it('reports the backlog on every batch, including one that claimed nothing', async () => {
    const queue = new FakeQueue();

    const drained = await runOutboxBatch(queue.database, {}, OPTIONS);
    expect(drained.claimed).toBe(0);
    expect(drained.backlog).toEqual({ pending: 0, parked: 0, oldestPendingSeconds: null });

    // An hour-old row this batch cannot take — another relay holds it, or the claim window is
    // full. Claiming nothing must no longer look like having nothing to do.
    queue.add('waiting', 'plain.v1', 3600);
    const report = await runOutboxBatch(queue.database, {}, { ...OPTIONS, batchSize: 0 });

    expect(report.claimed).toBe(0);
    expect(report.backlog.pending).toBe(1);
    expect(report.backlog.oldestPendingSeconds).toBeGreaterThanOrEqual(3_599);
  });
});

describe('whole-batch failure compensation (CRITICAL-B)', () => {
  it('refunds the reserved attempt when the batch fails for a recoverable reason', async () => {
    // A deadlock / lost transaction is caught, not a process kill: the process survives to
    // refund. Before this fix the reservation`s `attempts + 1` stood, and a recurring deadlock
    // marched a whole batch of never-delivered rows into parking at poll rate.
    const queue = new FakeQueue();
    queue.add('a', 'plain.v1', 60);
    queue.add('b', 'plain.v1', 30);

    const database = queue.rejectedBatch(
      new OutboxTransactionLostError(new Error('deadlock 1213')),
    );
    await expect(runOutboxBatch(database, {}, OPTIONS)).rejects.toBeInstanceOf(
      OutboxTransactionLostError,
    );

    // Reserved (attempts → 1), then refunded (→ 0): an ordinary deadlock costs the rows
    // nothing, exactly as it did before claim-time counting.
    expect(queue.row('a').attempts).toBe(0);
    expect(queue.row('b').attempts).toBe(0);
  });

  it('refunds on a driver statement-timeout / connection error too', async () => {
    const queue = new FakeQueue();
    queue.add('a', 'plain.v1', 60);

    const timeout = Object.assign(new Error('query execution was interrupted'), { errno: 3024 });
    await expect(runOutboxBatch(queue.rejectedBatch(timeout), {}, OPTIONS)).rejects.toThrow(
      'interrupted',
    );
    expect(queue.row('a').attempts).toBe(0);
  });

  it('does NOT refund an unrecognised failure — a process kill keeps its attempt (CRITICAL-1)', async () => {
    // The safe direction: an error we do not recognise might be the process-killing handler
    // CRITICAL-1 exists for, so the row keeps the attempt and still parks. `killedDuringBatch`
    // rejects with a plain Error, which the classifier treats as unrecoverable.
    const queue = new FakeQueue();
    queue.add('poison', 'poison.v1');

    await expect(runOutboxBatch(queue.killedDuringBatch(), {}, OPTIONS)).rejects.toThrow(
      'process killed mid-batch',
    );
    expect(queue.row('poison').attempts).toBe(1);
  });

  it('keeps the attempt on the handler whose own deadlock lost the batch, so it parks (IMPORTANT-1)', async () => {
    // `withSavepoint` turns a handler's ER_LOCK_DEADLOCK into `OutboxTransactionLostError`, which
    // the classifier calls recoverable — so refunding *every* reserved row refunded the culprit
    // too. A handler with a real lock-ordering bug against the API therefore repeated for ever:
    // `attempts` back to its old value on every pass, the row still first under
    // `ORDER BY available_at, id`, nothing behind it draining. That is CRITICAL-1's failure
    // shape surviving for the deadlock class. The culprit now pays; its batch-mate still does not.
    const queue = new FakeQueue();
    queue.add('deadlocker', 'deadlocks.v1', 60);
    queue.add('innocent', 'plain.v1', 30);
    const handlers: OutboxHandlers = {
      'deadlocks.v1': () =>
        Promise.reject(
          Object.assign(new Error('Deadlock found when trying to get lock'), {
            errno: 1213,
          }),
        ),
      'plain.v1': () => Promise.resolve(),
    };

    for (let pass = 1; pass <= OPTIONS.maxAttempts; pass += 1) {
      await expect(runOutboxBatch(queue.database, handlers, OPTIONS)).rejects.toBeInstanceOf(
        OutboxTransactionLostError,
      );
      expect(queue.row('deadlocker').attempts).toBe(pass);
      expect(queue.row('innocent').attempts).toBe(0);
    }

    // At the cap it is parked, and everything behind it drains — the whole point.
    const after = await runOutboxBatch(queue.database, handlers, OPTIONS);
    expect(after.parked.map((event) => event.id)).toEqual(['deadlocker']);
    expect(queue.row('innocent').publishedAt).not.toBeNull();
  });
});

describe('replaying a parked event — relay:unpark (IMPORTANT-2)', () => {
  it('resets the named parked row to pending and leaves every other parked row alone', async () => {
    // Without a way out, one poison event makes `relay:status` and `relay:once` exit 1 on every
    // run for ever, and an alarm with no stand-down is an alarm somebody switches off.
    const queue = new FakeQueue();
    queue.add('replayed', 'throws.v1');
    queue.add('still-parked', 'throws.v1');
    const failing: OutboxHandlers = { 'throws.v1': () => Promise.reject(new Error('boom')) };

    for (let attempt = 1; attempt <= OPTIONS.maxAttempts; attempt += 1) {
      for (const row of queue.rows) row.availableAt = new Date(Date.now() - 1000);
      await runOutboxBatch(queue.database, failing, OPTIONS);
    }
    expect(queue.row('replayed').attempts).toBe(OPTIONS.maxAttempts);

    const replayed = await queue.database.transaction((tx) =>
      unparkEvents(tx, OPTIONS.maxAttempts, 'replayed'),
    );

    // Reported before the reset, so the operator's log keeps the attempt count and the row's
    // organization; the row itself goes back to pending with its stale diagnosis cleared.
    expect(replayed.map((event) => event.id)).toEqual(['replayed']);
    expect(replayed[0]?.attempts).toBe(OPTIONS.maxAttempts);
    expect(queue.row('replayed').attempts).toBe(0);
    expect(queue.row('replayed').lastError).toBeNull();
    expect(queue.row('still-parked').attempts).toBe(OPTIONS.maxAttempts);

    // And it is genuinely deliverable again — the claim takes it, the other stays parked.
    const report = await runOutboxBatch(
      queue.database,
      { 'throws.v1': () => Promise.resolve() },
      OPTIONS,
    );
    expect(report.published).toBe(1);
    expect(queue.row('replayed').publishedAt).not.toBeNull();
    expect(report.parked.map((event) => event.id)).toEqual(['still-parked']);
  });
});

describe('loop error backoff (CRITICAL-B, second half)', () => {
  const noJitter = (): number => 0;

  it('is the poll interval on the first error and grows exponentially, capped', () => {
    expect(loopErrorDelayMs(1, 5000, 900_000, noJitter)).toBe(5000);
    expect(loopErrorDelayMs(2, 5000, 900_000, noJitter)).toBe(10_000);
    expect(loopErrorDelayMs(3, 5000, 900_000, noJitter)).toBe(20_000);
    // Capped rather than doubling to infinity.
    expect(loopErrorDelayMs(50, 5000, 900_000, noJitter)).toBe(900_000);
  });

  it('adds bounded jitter so relays that failed together do not retry in lockstep', () => {
    const full = loopErrorDelayMs(1, 5000, 900_000, () => 1);
    expect(full).toBeGreaterThan(5000);
    expect(full).toBeLessThanOrEqual(6250); // base + 25%
  });

  it('is zero before the first error', () => {
    expect(loopErrorDelayMs(0, 5000, 900_000, noJitter)).toBe(0);
  });
});

/**
 * IMPORTANT-D: the backlog aggregate must be read on `database.read`, outside the batch
 * transaction, not inside it. This spy answers each channel separately and records which one
 * the aggregate was issued on.
 */
describe('the backlog aggregate is read outside the batch transaction (IMPORTANT-D)', () => {
  class ChannelSpy {
    readonly viaTransaction: string[] = [];
    readonly viaRead: string[] = [];

    private make(sink: string[]): WorkerTransaction {
      return {
        query: <T>(sql: string): Promise<T> => {
          const text = sql.trim().toUpperCase();
          sink.push(text);
          // The backlog read (NOW_AT marker) returns no rows — a drained queue — and so does
          // everything else (reserve select, claim, parked list). This spy only records which
          // channel each statement was issued on.
          return Promise.resolve([] as T);
        },
      };
    }

    readonly database: WorkerDatabase = {
      transaction: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> =>
        work(this.make(this.viaTransaction)),
      read: <T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> =>
        work(this.make(this.viaRead)),
      end: () => Promise.resolve(),
    };
  }

  it('issues the aggregate through read(), never inside a transaction', async () => {
    const spy = new ChannelSpy();
    await runOutboxBatch(spy.database, {}, OPTIONS);

    const isAggregate = (text: string): boolean => text.includes('NOW_AT');
    expect(spy.viaRead.some(isAggregate)).toBe(true);
    expect(spy.viaTransaction.some(isAggregate)).toBe(false);
  });
});
