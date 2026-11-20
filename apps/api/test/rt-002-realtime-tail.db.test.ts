import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  RealtimeHub,
  createRealtimeFanOutHandlers,
  createRealtimeTail,
  createWorkerDatabase,
  tailPageSql,
} from '@tmanage/worker';
import type { RealtimeEventFrame, WorkerDatabase, WorkerTransaction } from '@tmanage/worker';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * DC-3 / RT-2 (lane K) — the realtime tail on a real MariaDB 11.8, on the worker credential.
 *
 * What only this suite proves (the unit suites use an in-memory outbox):
 *
 * 1. **Two copies, one client each, both framed once.** Two tails on their own pools and hubs
 *    follow the same published rows; each client gets each event exactly once over many polls.
 * 2. **A late commit is found.** A row whose transaction commits after a later row was already
 *    read (the hazard Confluent's `timestamp.delay.interval.ms` exists for) is framed by the
 *    lookback pass, on InnoDB's real visibility rules.
 * 3. **Reads only.** The tail runs on `tmanage_worker`, never locks a row: a relay transaction
 *    holding `FOR UPDATE` on the same rows does not block it.
 * 4. **It walks the claim index** `ix_outbox_events_unpublished` (EXPLAIN's possible keys).
 */

let db: TestDatabase;
const databases: WorkerDatabase[] = [];
const ORG = randomUUID();
const T0 = new Date('2031-05-06T07:08:09.010Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function pool(): WorkerDatabase {
  const database = createWorkerDatabase({
    url: db.workerUrl,
    connectionLimit: 2,
    statementTimeoutMs: 15_000,
  });
  databases.push(database);
  return database;
}

const INSERT = `INSERT INTO outbox_events
  (id, organization_id, type, aggregate_type, aggregate_id, payload_json, occurred_at,
   available_at, published_at, attempts)
  VALUES (?, ?, 'message.created.v1', 'message', ?, ?, ?, ?, ?, 1)`;

function publishedRow(tx: WorkerTransaction, id: string, publishedAt: Date): Promise<unknown> {
  const messageId = randomUUID();
  return tx.query(INSERT, [
    id,
    ORG,
    messageId,
    JSON.stringify({ conversationId: 'conv-1', messageId, sequence: 1 }),
    publishedAt,
    publishedAt,
    publishedAt,
  ]);
}

function copy(database: WorkerDatabase) {
  const hub = new RealtimeHub();
  const frames: RealtimeEventFrame[] = [];
  hub.subscribe(ORG, 'conv-1', (frame) => frames.push(frame as RealtimeEventFrame));
  const tail = createRealtimeTail({ database, handlers: createRealtimeFanOutHandlers(hub) });
  return { frames, tail };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await db.admin.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'rt2', 'RT2')`, [
    ORG,
  ]);
}, 300_000);

beforeEach(async () => {
  await db.admin.query('DELETE FROM outbox_events WHERE organization_id = ?', [ORG]);
});

afterAll(async () => {
  await Promise.all(databases.map((d) => d.end()));
  await db?.stop();
});

describe('RT-2 realtime tail on MariaDB', () => {
  it('two copies, one client each: both get every event exactly once', async () => {
    const writer = pool();
    await writer.transaction((tx) => publishedRow(tx, randomUUID(), at(0)));
    const copies = [copy(pool()), copy(pool())];
    for (const c of copies) await c.tail.start();

    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await writer.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await publishedRow(tx, id, at(1_000 + i));
    });
    for (let poll = 0; poll < 4; poll += 1) for (const c of copies) await c.tail.tick();

    for (const c of copies) {
      // History (the row before start) is not replayed; the three new ones once each.
      expect(c.frames).toHaveLength(3);
      expect(new Set(c.frames.map((f) => f.objectId)).size).toBe(3);
    }
  });

  it('a row committed after a later row was read is framed by the lookback', async () => {
    const writer = pool();
    const { frames, tail } = copy(pool());
    await tail.start();

    let commitLate!: () => void;
    const held = new Promise<void>((resolve) => {
      commitLate = resolve;
    });
    const lateId = randomUUID();
    const late = writer.transaction(async (tx) => {
      await publishedRow(tx, lateId, at(2_000));
      await held;
    });
    // A later row commits first and is read while the earlier one is still uncommitted.
    await writer.transaction((tx) => publishedRow(tx, randomUUID(), at(2_500)));
    await tail.tick();
    expect(frames).toHaveLength(1);

    commitLate();
    await late;
    await tail.tick();
    expect(frames).toHaveLength(2);
    await tail.tick();
    expect(frames).toHaveLength(2);
  });

  it('reads without locking: a relay holding FOR UPDATE on the rows does not block it', async () => {
    const writer = pool();
    const { frames, tail } = copy(pool());
    await tail.start();
    await writer.transaction((tx) => publishedRow(tx, randomUUID(), at(3_000)));

    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const relay = pool().transaction(async (tx) => {
      await tx.query('SELECT id FROM outbox_events WHERE organization_id = ? FOR UPDATE', [ORG]);
      locked();
      await holding;
    });
    await isLocked;
    const report = await tail.tick();
    release();
    await relay;
    expect(report.framed).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it('walks the claim index', async () => {
    const [plan] = await db.admin.query<RowDataPacket[]>(`EXPLAIN ${tailPageSql(1)}`, [
      at(0),
      at(0),
      null,
      'message.created.v1',
      200,
    ]);
    const keys = String(plan[0]?.['possible_keys'] ?? '');
    expect(keys).toContain('ix_outbox_events_unpublished');
  });
});
