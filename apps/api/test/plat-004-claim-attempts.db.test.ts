import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import {
  createWorkerDatabase,
  readOutboxBacklog,
  reserveDueEvents,
  runOutboxBatch,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The two Critical findings of the worker/outbox audit, against a real server.
 *
 * **CRITICAL-1 — a handler that kills the process never records a failure.**
 *
 * > `attempts` is only ever incremented by `recordFailure`, which runs when a handler
 * > *throws*. A handler that instead kills the process — OOM on a large payload, an
 * > unhandled rejection in a nested await, the host's OOM killer, a `SIGKILL` mid-batch —
 * > never reaches that line. The server rolls the transaction back, releases the locks, and
 * > the row returns to the table with `attempts` unchanged. [...] Parking is arithmetic on
 * > `attempts` [...] and `attempts` never moves, so R can never park. Every event behind R
 * > — every notification, every client email, every work-item lifecycle transition,
 * > org-wide — stops.
 *
 * **CRITICAL-2 — if the worker stopped draining right now, nothing would say so.**
 *
 * > A healthy idle worker prints nothing. A dead worker prints nothing. The two are
 * > indistinguishable from the log. [...] The single highest-value change on this list [...]
 * > is one database query, exposed as a health check, that answers "what is the oldest thing
 * > waiting to be delivered?"
 *
 * The unit suites (`apps/worker/src/outbox/claim-attempts.test.ts`,
 * `apps/worker/src/outbox/health.test.ts`) prove the dispatcher's arithmetic over a fake.
 * What only this file can prove is the part that matters most and a fake cannot reach:
 * **that the reservation's `attempts` increment is committed and therefore survives a
 * transaction that never commits** — which is exactly what a killed process leaves behind —
 * and that the backlog aggregate reads what MySQL actually stores, `TIMESTAMPDIFF`,
 * `NOW(3)`, NULL-on-empty and all.
 *
 * ── UNEXECUTED ────────────────────────────────────────────────────────────────
 * Written but **not run**: the database lock was held by another job for the whole session
 * this landed in, and the slice rules forbid starting mysqld. Run it with
 *
 *     pnpm test:db
 *
 * from the repository root, or just this file:
 *
 *     pnpm build:packages && pnpm build:worker && \
 *       pnpm --filter @tmanage/api exec vitest run --project database \
 *       test/plat-004-claim-attempts.db.test.ts
 *
 * Nothing below has been observed to pass. Treat a first green run as the proof, not this note.
 */

let db: TestDatabase;
let world: SeedWorld;
let workerDb: WorkerDatabase;

const OPTIONS = {
  batchSize: 25,
  maxAttempts: 3,
  // A minute of base backoff puts every retry outside this suite's runtime, so a row that
  // backed off is genuinely out of the next claim rather than usually out of it.
  backoffBaseMs: 60_000,
  backoffCapMs: 900_000,
};

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** One due, unpublished event of a type with no consumer, so delivery is a publish. */
async function insertEvent(type: string, secondsOld = 1): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into outbox_events
       (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
        payload_json, occurred_at, available_at)
     values (?, ?, ?, 1, 'work_item', ?, '{}',
             date_sub(utc_timestamp(3), interval ? second),
             date_sub(utc_timestamp(3), interval ? second))`,
    [id, world.northstar.organizationId, type, uuidv7(), secondsOld, secondsOld],
  );
  return id;
}

async function attemptsOf(id: string): Promise<number> {
  const rows = await observe('select attempts from outbox_events where id = ?', [id]);
  return Number(rows[0]?.['attempts']);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('CRITICAL-1 — the attempt is committed before the handler runs', () => {
  it('survives a batch transaction that is rolled back whole', async () => {
    const id = await insertEvent('unconsumed.critical1.v1');

    // The reservation, in its own transaction — exactly as `runOutboxBatch` opens it.
    const reserved = await workerDb.transaction((tx) =>
      reserveDueEvents(tx, { limit: OPTIONS.batchSize, maxAttempts: OPTIONS.maxAttempts }),
    );
    expect(reserved).toContain(id);
    expect(await attemptsOf(id)).toBe(1);

    // Now lose the batch the way a killed process loses it: a transaction that never
    // commits. Before this change, `attempts` was only ever written inside this transaction,
    // so it went back to 0 here and the row was re-claimed first at every restart for ever.
    await expect(
      workerDb.transaction(async (tx) => {
        await tx.query('select 1');
        throw new Error('[simulated] the process died mid-batch');
      }),
    ).rejects.toThrow('died mid-batch');

    expect(await attemptsOf(id)).toBe(1);
    const rows = await observe('select published_at from outbox_events where id = ?', [id]);
    expect(rows[0]?.['published_at']).toBeNull();
  });

  it('parks a row that dies on every restart, and drains what was queued behind it', async () => {
    const poison = await insertEvent('unconsumed.critical1.v1', 600);

    for (let restart = 0; restart < OPTIONS.maxAttempts; restart += 1) {
      const reserved = await workerDb.transaction((tx) =>
        reserveDueEvents(tx, { limit: OPTIONS.batchSize, maxAttempts: OPTIONS.maxAttempts }),
      );
      expect(reserved).toContain(poison);
      await expect(
        workerDb.transaction(() => Promise.reject(new Error('[simulated] killed'))),
      ).rejects.toThrow('killed');
    }
    expect(await attemptsOf(poison)).toBe(OPTIONS.maxAttempts);

    // Parked by arithmetic: never claimed again, still reported in every batch.
    const behind = await insertEvent('unconsumed.critical1.v1');
    const report = await runOutboxBatch(workerDb, {}, OPTIONS);

    expect(report.claimed).toBe(1);
    expect(report.published).toBe(1);
    expect(report.parked.map((event) => event.id)).toContain(poison);
    const published = await observe(
      'select published_at from outbox_events where id in (?, ?) order by id',
      [poison, behind],
    );
    expect(published).toHaveLength(2);
  });

  it('spends exactly one attempt on an ordinary throwing handler', async () => {
    const id = await insertEvent('thrower.critical1.v1');
    const report = await runOutboxBatch(
      workerDb,
      { 'thrower.critical1.v1': () => Promise.reject(new Error('handler said no')) },
      OPTIONS,
    );

    expect(report.failures.map((failure) => failure.eventId)).toContain(id);
    expect(report.failures.find((failure) => failure.eventId === id)?.attempts).toBe(1);
    expect(await attemptsOf(id)).toBe(1);

    const rows = await observe(
      `select last_error, (available_at > utc_timestamp(3)) as backed_off
         from outbox_events where id = ?`,
      [id],
    );
    expect(String(rows[0]?.['last_error'])).toContain('handler said no');
    expect(Number(rows[0]?.['backed_off'])).toBe(1);
  });
});

describe('CRITICAL-2 — the backlog aggregate', () => {
  it('reads null for a drained queue, not zero', async () => {
    await db.admin.execute('update outbox_events set published_at = utc_timestamp(3)');
    const backlog = await workerDb.read((tx) => readOutboxBacklog(tx, OPTIONS.maxAttempts));

    expect(backlog).toEqual({ pending: 0, parked: 0, oldestPendingSeconds: null });
  });

  it('reports the age of the oldest pending row, in seconds, from the server clock', async () => {
    await insertEvent('unconsumed.critical2.v1', 7200);
    await insertEvent('unconsumed.critical2.v1', 5);
    const backlog = await workerDb.read((tx) => readOutboxBacklog(tx, OPTIONS.maxAttempts));

    expect(backlog.pending).toBe(2);
    expect(backlog.parked).toBe(0);
    // The audit's question — "what is the oldest thing waiting to be delivered?" — answered.
    expect(backlog.oldestPendingSeconds).toBeGreaterThanOrEqual(7_190);
  });

  it('counts parked rows separately and keeps them out of the age', async () => {
    await db.admin.execute('update outbox_events set published_at = utc_timestamp(3)');
    const parked = await insertEvent('unconsumed.critical2.v1', 86_400);
    await db.admin.execute('update outbox_events set attempts = ? where id = ?', [
      OPTIONS.maxAttempts,
      parked,
    ]);
    await insertEvent('unconsumed.critical2.v1', 10);

    const backlog = await workerDb.read((tx) => readOutboxBacklog(tx, OPTIONS.maxAttempts));

    expect(backlog.parked).toBe(1);
    expect(backlog.pending).toBe(1);
    // A permanently parked row must not pin the age at "growing for ever" and drown the
    // signal this reading exists to give.
    expect(backlog.oldestPendingSeconds).toBeLessThan(3_600);
  });

  it('floors a row backed off into the future at zero rather than reporting a negative', async () => {
    await db.admin.execute('update outbox_events set published_at = utc_timestamp(3)');
    const id = await insertEvent('unconsumed.critical2.v1');
    await db.admin.execute(
      'update outbox_events set available_at = date_add(utc_timestamp(3), interval 600 second) where id = ?',
      [id],
    );

    const backlog = await workerDb.read((tx) => readOutboxBacklog(tx, OPTIONS.maxAttempts));
    expect(backlog.pending).toBe(1);
    expect(backlog.oldestPendingSeconds).toBe(0);
  });

  it('is readable on the relay credential the deployment actually uses', async () => {
    // The reading is deliberately the worker's, not the API's: `tmanage_worker` already holds
    // SELECT on `outbox_events`, so no grant in `scripts/db/users.sql` had to change. If this
    // ever fails with a privilege error, that decision was reversed somewhere.
    await expect(
      workerDb.read((tx) => readOutboxBacklog(tx, OPTIONS.maxAttempts)),
    ).resolves.toBeDefined();
  });
});
