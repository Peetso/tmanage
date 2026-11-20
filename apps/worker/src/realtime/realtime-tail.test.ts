import { describe, expect, it } from 'vitest';
import { TAIL_START_SQL, tailPageSql } from '../common/database/realtime-tail-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import { RealtimeHub } from './hub.js';
import type { RealtimeEventFrame } from './hub.js';
import { createRealtimeFanOutHandlers, createRealtimeTail } from './realtime-tail.js';
import { WORK_FRAME_EVENT_TYPES } from './work-fan-out.js';

/**
 * DC-3 / RT-2 — the realtime tail over an in-memory outbox that answers the tail's two
 * statements the way MariaDB does (only committed rows are visible; keyset order
 * `(published_at, id)`; `id > NULL` is never true). The same statements against a real
 * MariaDB 11.8: `apps/api/test/rt-002-realtime-tail.db.test.ts`.
 */

interface Row {
  id: string;
  organization_id: string;
  type: string;
  payload_json: string;
  published_at: Date;
  committed: boolean;
}

const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);

function fakeOutbox() {
  const rows: Row[] = [];
  const reads: string[] = [];
  const query = <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
    reads.push(sql);
    const visible = rows.filter((row) => row.committed);
    if (sql === TAIL_START_SQL) {
      const max = visible.reduce<Date | null>(
        (best, row) => (best === null || row.published_at > best ? row.published_at : best),
        null,
      );
      return Promise.resolve([{ published_at: max }] as T);
    }
    const [time, sameTime, id, ...rest] = params as [Date, Date, string | null, ...unknown[]];
    expect(sameTime).toBe(time);
    const limit = rest.pop() as number;
    const types = rest as string[];
    expect(sql).toBe(tailPageSql(types.length));
    const page = visible
      .filter(
        (row) =>
          (row.published_at.getTime() > time.getTime() ||
            (row.published_at.getTime() === time.getTime() && id !== null && row.id > id)) &&
          types.includes(row.type),
      )
      .sort((a, b) => a.published_at.getTime() - b.published_at.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({
        ...row,
        schema_version: 1,
        aggregate_type: 'message',
        aggregate_id: row.id,
        correlation_id: null,
        occurred_at: row.published_at,
        attempts: 1,
      }));
    return Promise.resolve(page as T);
  };
  const tx: WorkerTransaction = { query };
  const database = { read: <T>(work: (t: WorkerTransaction) => Promise<T>) => work(tx) };
  const publish = (id: string, ms: number, committed = true, type = 'message.created.v1') => {
    const row: Row = {
      id,
      organization_id: 'org-1',
      type,
      payload_json: JSON.stringify({ conversationId: 'conv-1', messageId: `m-${id}`, sequence: 1 }),
      published_at: at(ms),
      committed,
    };
    rows.push(row);
    return row;
  };
  return { database, publish, reads };
}

function counting() {
  const framed: string[] = [];
  const handler: OutboxHandler = (event) => {
    framed.push(event.id);
    return Promise.resolve();
  };
  return { framed, handlers: { 'message.created.v1': handler } };
}

describe('RT-2 realtime tail', () => {
  it('starts at the newest published row and never replays history', async () => {
    const outbox = fakeOutbox();
    outbox.publish('a', 0);
    outbox.publish('b', 1_000);
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers });
    await tail.start();
    expect(await tail.tick()).toEqual({ framed: 0, duplicates: 0, failed: 0, truncated: false });
    outbox.publish('c', 2_000);
    await tail.tick();
    expect(framed).toEqual(['c']);
  });

  it('frames each event once, however often the lookback window re-reads it', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers });
    await tail.start();
    outbox.publish('a', 100);
    outbox.publish('b', 200);
    await tail.tick();
    const again = await tail.tick();
    await tail.tick();
    expect(framed).toEqual(['a', 'b']);
    expect(again.duplicates).toBe(2);
  });

  it('finds a row that committed after a later one was read, inside the lookback', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers, lookbackMs: 5_000 });
    await tail.start();
    const late = outbox.publish('late', 100, false);
    outbox.publish('early-commit', 300);
    await tail.tick();
    late.committed = true;
    await tail.tick();
    expect(framed).toEqual(['early-commit', 'late']);
  });

  it('a row committing later than the lookback is not framed live (documented bound)', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers, lookbackMs: 1_000 });
    await tail.start();
    const late = outbox.publish('late', 100, false);
    outbox.publish('next', 5_000);
    await tail.tick();
    late.committed = true;
    await tail.tick();
    expect(framed).toEqual(['next']);
  });

  it('reads a window wider than one page in keyset pages, same-millisecond rows included', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers, pageSize: 2 });
    await tail.start();
    for (const id of ['a', 'b', 'c', 'd', 'e']) outbox.publish(id, 100);
    const report = await tail.tick();
    expect(framed).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(report.truncated).toBe(false);
  });

  it('stops at maxPages, says so, and goes on from there on the next poll', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({
      database: outbox.database,
      handlers,
      pageSize: 2,
      maxPages: 1,
    });
    await tail.start();
    for (const [i, id] of ['a', 'b', 'c'].entries()) outbox.publish(id, 100 + i);
    expect((await tail.tick()).truncated).toBe(true);
    await tail.tick();
    expect(framed).toEqual(['a', 'b', 'c']);
  });

  it('forgets ids that fell out of the window, so memory stays bounded', async () => {
    const outbox = fakeOutbox();
    const { handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers, lookbackMs: 1_000 });
    await tail.start();
    outbox.publish('a', 100);
    await tail.tick();
    expect(tail.remembered()).toBe(1);
    outbox.publish('b', 10_000);
    await tail.tick();
    expect(tail.remembered()).toBe(1);
  });

  it('a failing handler is reported once and not retried; the next event still frames', async () => {
    const outbox = fakeOutbox();
    const errors: string[] = [];
    let calls = 0;
    const tail = createRealtimeTail({
      database: outbox.database,
      handlers: {
        'message.created.v1': (event) => {
          calls += 1;
          return event.id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve();
        },
      },
      onHandlerError: (event) => errors.push(event.id),
    });
    await tail.start();
    outbox.publish('bad', 100);
    outbox.publish('good', 200);
    const first = await tail.tick();
    await tail.tick();
    expect(first).toMatchObject({ framed: 1, failed: 1 });
    expect(errors).toEqual(['bad']);
    expect(calls).toBe(2);
  });

  it('asks only for the types it frames', async () => {
    const outbox = fakeOutbox();
    const { framed, handlers } = counting();
    const tail = createRealtimeTail({ database: outbox.database, handlers });
    await tail.start();
    outbox.publish('mail', 100, true, 'client_request.submitted.v1');
    outbox.publish('chat', 200);
    await tail.tick();
    expect(framed).toEqual(['chat']);
  });

  it('two copies, each with its own hub and client: both clients get the frame exactly once', async () => {
    const outbox = fakeOutbox();
    const copies = [new RealtimeHub(), new RealtimeHub()].map((hub) => {
      const got: RealtimeEventFrame[] = [];
      hub.subscribe('org-1', 'conv-1', (frame) => got.push(frame as RealtimeEventFrame));
      const tail = createRealtimeTail({
        database: outbox.database,
        handlers: createRealtimeFanOutHandlers(hub),
      });
      return { got, tail };
    });
    for (const copy of copies) await copy.tail.start();
    outbox.publish('e1', 100);
    for (let poll = 0; poll < 3; poll += 1) for (const copy of copies) await copy.tail.tick();
    for (const copy of copies) {
      expect(copy.got).toHaveLength(1);
      expect(copy.got[0]).toMatchObject({ eventType: 'message.created.v1', objectId: 'm-e1' });
    }
  });

  it('frames messages, direct messages and every work event type', () => {
    expect(Object.keys(createRealtimeFanOutHandlers(new RealtimeHub())).sort()).toEqual(
      ['message.created.v1', 'direct_message.created.v1', ...WORK_FRAME_EVENT_TYPES].sort(),
    );
  });
});

describe('RT-2 realtime tail store', () => {
  it('reads published rows only, never claims, locks or writes', () => {
    for (const sql of [TAIL_START_SQL, tailPageSql(3)]) {
      expect(sql).toMatch(/^\s*SELECT /u);
      expect(sql).not.toMatch(/FOR UPDATE|LOCK IN SHARE|UPDATE |INSERT |DELETE |GET_LOCK/iu);
      expect(sql).not.toMatch(/current_timestamp|now\(|utc_timestamp|sysdate/iu);
    }
    expect(tailPageSql(3)).toMatch(/ORDER BY published_at, id\s+LIMIT \?$/u);
    expect(tailPageSql(2)).toContain('type IN (?, ?)');
  });
});
