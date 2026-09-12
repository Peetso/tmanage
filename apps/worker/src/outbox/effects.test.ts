import { describe, expect, it } from 'vitest';
import { runOutboxBatch } from './dispatcher.js';
import type { OutboxHandlers } from './dispatcher.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/**
 * The after-commit rules, over a database stubbed down to the four statements the dispatcher
 * issues. A fake, deliberately: what is under test here is *when* an effect runs relative to
 * the transaction boundary, and a real server proves the boundary but hides the ordering.
 * The same rules over real rows are in `apps/api/test/notif-002-client-request-mail.db.test.ts`.
 */

interface FakeEvent {
  readonly id: string;
  readonly type: string;
  readonly attempts: number;
}

const OPTIONS = { batchSize: 10, maxAttempts: 5, backoffBaseMs: 1000, backoffCapMs: 60_000 };

/**
 * A transaction that answers the dispatcher's statements and records the order of everything
 * it was asked to do, so a test can say "the commit happened first".
 *
 * Two of them are newer than this suite: the reservation's `SELECT id` and its
 * `attempts = attempts + 1` (CRITICAL-1's claim-time bookkeeping, `outbox-store.ts`). They
 * are logged under their own names so `fail` keeps meaning exactly what it meant when these
 * tests were written — `recordFailure` ran — and every assertion below still says what it said.
 */
function fakeDatabase(
  events: readonly FakeEvent[],
  log: string[],
  options: {
    readonly failCommit?: boolean;
    /** Make `ROLLBACK TO SAVEPOINT` fail, as it does once the transaction itself is gone. */
    readonly savepointGone?: boolean;
  } = {},
): WorkerDatabase {
  const tx = {
    query: (sql: string, params?: readonly unknown[]): Promise<unknown> => {
      const text = sql.trim().toUpperCase();
      if (text.startsWith('ROLLBACK') && options.savepointGone === true) {
        log.push('rollback-failed');
        return Promise.reject(
          Object.assign(new Error('SAVEPOINT outbox_event does not exist'), { errno: 1305 }),
        );
      }
      if (
        text.startsWith('SELECT') &&
        text.includes('FOR UPDATE') &&
        !text.includes('PAYLOAD_JSON')
      ) {
        log.push('reserve-select');
        return Promise.resolve(events.map((event) => ({ id: event.id })));
      }
      if (text.startsWith('UPDATE') && text.includes('ATTEMPTS = ATTEMPTS + 1')) {
        log.push('reserve-attempt');
        return Promise.resolve({ affectedRows: events.length });
      }
      if (text.startsWith('SELECT') && text.includes('FOR UPDATE')) {
        log.push('claim');
        return Promise.resolve(
          events.map((event) => ({
            id: event.id,
            type: event.type,
            // As the reservation left it: the attempt is counted before the handler runs.
            attempts: event.attempts + 1,
            organization_id: 'org-1',
            schema_version: 1,
            aggregate_type: 'client_request',
            aggregate_id: 'req-1',
            payload_json: JSON.stringify({ requestId: 'req-1' }),
            correlation_id: null,
            occurred_at: new Date(0),
          })),
        );
      }
      if (text.startsWith('UPDATE')) {
        log.push(text.includes('PUBLISHED_AT') ? `publish:${String(params?.[0])}` : 'fail');
        return Promise.resolve({ affectedRows: 1 });
      }
      if (text.startsWith('SAVEPOINT') || text.startsWith('ROLLBACK') || text.startsWith('RELEASE'))
        return Promise.resolve(undefined);
      log.push('parked-query');
      return Promise.resolve([]);
    },
  } as unknown as WorkerTransaction;

  // One batch is two transactions now — the reservation, then the batch proper. Only the
  // second one's commit is the one these tests mean by "the commit".
  let transactions = 0;
  return {
    transaction: async <T>(run: (tx: WorkerTransaction) => Promise<T>): Promise<T> => {
      transactions += 1;
      const isBatch = transactions > 1;
      const result = await run(tx);
      if (isBatch && options.failCommit === true) {
        log.push('commit-failed');
        throw new Error('lost connection at COMMIT');
      }
      if (isBatch) log.push('commit');
      return result;
    },
  } as unknown as WorkerDatabase;
}

describe('after-commit effects', () => {
  it('runs an effect only after the transaction has committed', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': (_event, _tx, effects) => {
        log.push('handler');
        effects.afterCommit(() => {
          log.push('effect');
          return Promise.resolve();
        });
        return Promise.resolve();
      },
    };

    const report = await runOutboxBatch(
      fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log),
      handlers,
      OPTIONS,
    );

    expect(report.effects).toBe(1);
    expect(report.effectFailures).toEqual([]);
    expect(log.indexOf('effect')).toBeGreaterThan(log.indexOf('commit'));
    expect(log.indexOf('effect')).toBeGreaterThan(log.indexOf('publish:e1'));
  });

  it('discards the effects of a handler whose savepoint rolled back', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('must-not-run');
          return Promise.resolve();
        });
        return Promise.reject(new Error('handler blew up after staging'));
      },
    };

    const report = await runOutboxBatch(
      fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log),
      handlers,
      OPTIONS,
    );

    expect(report.failed).toBe(1);
    expect(report.effects).toBe(0);
    expect(log).not.toContain('must-not-run');
  });

  it('keeps a surviving event’s effect when a sibling in the same batch failed', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'good.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('good-effect');
          return Promise.resolve();
        });
        return Promise.resolve();
      },
      'bad.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('bad-effect');
          return Promise.resolve();
        });
        return Promise.reject(new Error('nope'));
      },
    };

    const report = await runOutboxBatch(
      fakeDatabase(
        [
          { id: 'e1', type: 'good.v1', attempts: 0 },
          { id: 'e2', type: 'bad.v1', attempts: 0 },
        ],
        log,
      ),
      handlers,
      OPTIONS,
    );

    expect(report.effects).toBe(1);
    expect(log).toContain('good-effect');
    expect(log).not.toContain('bad-effect');
  });

  it('runs nothing when the batch never committed', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('must-not-run');
          return Promise.resolve();
        });
        return Promise.resolve();
      },
    };

    await expect(
      runOutboxBatch(
        fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log, { failCommit: true }),
        handlers,
        OPTIONS,
      ),
    ).rejects.toThrow('lost connection at COMMIT');
    expect(log).not.toContain('must-not-run');
  });

  it('reports an effect that threw and does not un-publish its event', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => Promise.reject(new Error('smtp said no')));
        effects.afterCommit(() => {
          log.push('later-effect');
          return Promise.resolve();
        });
        return Promise.resolve();
      },
    };

    const report = await runOutboxBatch(
      fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log),
      handlers,
      OPTIONS,
    );

    expect(report.published).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.effects).toBe(2);
    expect(report.effectFailures).toEqual([
      { eventId: 'e1', type: 'a.v1', error: 'Error: smtp said no' },
    ]);
    // One effect's failure does not cancel the next one.
    expect(log).toContain('later-effect');
  });

  it('aborts the batch when the server rolled the whole transaction back', async () => {
    // The defect a review fleet found on 2026-08-31. InnoDB's deadlock victim (1213) has its
    // *entire* transaction rolled back, destroying every savepoint and every `published_at`
    // the batch had already stamped. Caught as an ordinary handler error, the dispatcher
    // would report the earlier events as published and run their staged effects — sending
    // mail for events the next batch will re-claim and mail again.
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'good.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('must-not-run');
          return Promise.resolve();
        });
        return Promise.resolve();
      },
      'victim.v1': () =>
        Promise.reject(Object.assign(new Error('Deadlock found'), { errno: 1213 })),
    };

    await expect(
      runOutboxBatch(
        fakeDatabase(
          [
            { id: 'e1', type: 'good.v1', attempts: 0 },
            { id: 'e2', type: 'victim.v1', attempts: 0 },
          ],
          log,
        ),
        handlers,
        OPTIONS,
      ),
    ).rejects.toThrow('the batch transaction was rolled back by the server');

    expect(log).not.toContain('must-not-run');
    // And no failure was recorded either: `recordFailure` would have run outside any
    // transaction and counted an attempt against an event that was never really tried.
    expect(log).not.toContain('fail');
  });

  it('aborts the batch when the savepoint rollback itself fails', async () => {
    // The catch-all: whatever destroys a transaction takes its savepoints with it, and
    // `ROLLBACK TO SAVEPOINT` failing is where that becomes observable.
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': (_event, _tx, effects) => {
        effects.afterCommit(() => {
          log.push('must-not-run');
          return Promise.resolve();
        });
        return Promise.reject(new Error('an ordinary handler failure'));
      },
    };

    await expect(
      runOutboxBatch(
        fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log, { savepointGone: true }),
        handlers,
        OPTIONS,
      ),
    ).rejects.toThrow('the batch transaction was rolled back by the server');
    expect(log).toContain('rollback-failed');
    expect(log).not.toContain('must-not-run');
    expect(log).not.toContain('fail');
  });

  it('still records an ordinary handler failure as one event\u2019s failure', async () => {
    // The other side of the same fork: nothing above may turn a normal failure into a batch
    // abort. `withSavepoint` rolls back, `recordFailure` runs, the batch commits.
    const log: string[] = [];
    const handlers: OutboxHandlers = {
      'a.v1': () => Promise.reject(new Error('an ordinary handler failure')),
    };
    const report = await runOutboxBatch(
      fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log),
      handlers,
      OPTIONS,
    );
    expect(report.failed).toBe(1);
    expect(log).toContain('fail');
    expect(log).toContain('commit');
  });

  it('leaves the counts at zero for a handler that stages nothing', async () => {
    const log: string[] = [];
    const handlers: OutboxHandlers = { 'a.v1': () => Promise.resolve() };
    const report = await runOutboxBatch(
      fakeDatabase([{ id: 'e1', type: 'a.v1', attempts: 0 }], log),
      handlers,
      OPTIONS,
    );
    expect(report.effects).toBe(0);
    expect(report.effectFailures).toEqual([]);
  });
});
