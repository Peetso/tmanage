import { describe, expect, it } from 'vitest';
import { runOutboxBatch } from './dispatcher.js';
import type { OutboxHandlers } from './dispatcher.js';
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
    this.rows.push({
      id,
      type,
      attempts: 0,
      publishedAt: null,
      availableAt: new Date(Date.now() - availableSecondsAgo * 1000),
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

      // The backlog aggregate.
      if (text.includes('OLDEST_PENDING_SECONDS')) {
        const unpublished = this.rows.filter((row) => row.publishedAt === null);
        const pending = unpublished.filter((row) => row.attempts < Number(params[0]));
        const ages = pending.map((row) =>
          Math.max(0, Math.floor((Date.now() - row.availableAt.getTime()) / 1000)),
        );
        return Promise.resolve([
          {
            pending: pending.length,
            parked: unpublished.length - pending.length,
            oldest_pending_seconds: ages.length === 0 ? null : Math.max(...ages),
          },
        ] as T);
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
