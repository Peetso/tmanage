import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REALTIME_PATH,
  applyRealtimePublicUrl,
  createUpgradeHandler,
  isRealtimeUpgrade,
  realtimeInProcessEnabled,
  realtimePublicUrlFor,
  leaderRelayHandlers,
  startRealtimeTail,
} from './realtime-inprocess.mjs';
import * as worker from '@tmanage/worker';

test('the socket is on with the in-process relay, and only then', () => {
  assert.equal(realtimeInProcessEnabled({ WORKER_INPROCESS: '1' }), true);
  assert.equal(realtimeInProcessEnabled({ WORKER_INPROCESS: '1', REALTIME_INPROCESS: '1' }), true);
  for (const off of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(
      realtimeInProcessEnabled({ WORKER_INPROCESS: '1', REALTIME_INPROCESS: off }),
      false,
    );
  }
  // No relay in this process: a socket would never receive a frame.
  assert.equal(realtimeInProcessEnabled({}), false);
  assert.equal(realtimeInProcessEnabled({ WORKER_INPROCESS: '0', REALTIME_INPROCESS: '1' }), false);
});

test('the public URL is the same origin over wss, on the realtime path', () => {
  assert.equal(realtimePublicUrlFor('https://tmanageapp.com'), 'wss://tmanageapp.com/realtime');
  assert.equal(realtimePublicUrlFor('https://example.test/app/'), 'wss://example.test/realtime');
  assert.equal(realtimePublicUrlFor('http://localhost:3000'), 'ws://localhost:3000/realtime');
  assert.equal(realtimePublicUrlFor(undefined), undefined);
  assert.equal(realtimePublicUrlFor(''), undefined);
  assert.equal(realtimePublicUrlFor('not a url'), undefined);
  assert.equal(realtimePublicUrlFor('ftp://example.test'), undefined);
});

test('an operator value is kept; otherwise the derived URL is set; off sets nothing', () => {
  const own = {
    WORKER_INPROCESS: '1',
    REALTIME_PUBLIC_URL: 'wss://rt.example.test/s',
    WEB_PUBLIC_URL: 'https://a.test',
  };
  applyRealtimePublicUrl(own);
  assert.equal(own.REALTIME_PUBLIC_URL, 'wss://rt.example.test/s');

  const derived = { WORKER_INPROCESS: '1', WEB_PUBLIC_URL: 'https://a.test' };
  applyRealtimePublicUrl(derived);
  assert.equal(derived.REALTIME_PUBLIC_URL, 'wss://a.test/realtime');

  const off = { WORKER_INPROCESS: '1', REALTIME_INPROCESS: '0', WEB_PUBLIC_URL: 'https://a.test' };
  applyRealtimePublicUrl(off);
  assert.equal(off.REALTIME_PUBLIC_URL, undefined);

  const noSite = { WORKER_INPROCESS: '1' };
  applyRealtimePublicUrl(noSite);
  assert.equal(noSite.REALTIME_PUBLIC_URL, undefined);
});

test('only the realtime path is an upgrade target, ticket query allowed', () => {
  assert.equal(REALTIME_PATH, '/realtime');
  assert.equal(isRealtimeUpgrade('/realtime?ticket=abc'), true);
  assert.equal(isRealtimeUpgrade('/realtime'), true);
  assert.equal(isRealtimeUpgrade('/v1/realtime'), false);
  assert.equal(isRealtimeUpgrade('/realtime/x'), false);
  assert.equal(isRealtimeUpgrade(undefined), false);
});

function fakeSocket() {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

test('upgrades reach the socket server only when it exists and the path matches', () => {
  const handed = [];
  const realtime = { handleUpgrade: (req, socket, head) => handed.push([req.url, socket, head]) };

  let current;
  const handler = createUpgradeHandler(() => current);

  const early = fakeSocket();
  handler({ url: '/realtime?ticket=t' }, early, Buffer.alloc(0));
  assert.equal(early.destroyed, true, 'refused while starting');

  current = realtime;
  const other = fakeSocket();
  handler({ url: '/_next/webpack-hmr' }, other, Buffer.alloc(0));
  assert.equal(other.destroyed, true, 'other paths are closed');

  const live = fakeSocket();
  handler({ url: '/realtime?ticket=t' }, live, Buffer.alloc(0));
  assert.equal(live.destroyed, false);
  assert.equal(handed.length, 1);
  assert.equal(handed[0][0], '/realtime?ticket=t');
});

// DC-3 / RT-2 — a shared outbox both copies read. It answers the tail's two statements as
// MariaDB does (committed rows only, keyset order `(published_at, id)`); anything else (the link
// preview's reads) finds nothing.
function sharedOutbox() {
  const rows = [];
  const query = async (sql, params = []) => {
    if (sql === worker.TAIL_START_SQL) {
      const times = rows.filter((row) => row.committed).map((row) => row.published_at.getTime());
      return [{ published_at: times.length === 0 ? null : new Date(Math.max(...times)) }];
    }
    if (!/FROM outbox_events\s+WHERE \(published_at > \?/u.test(sql)) return [];
    const [time, , id, ...rest] = params;
    const limit = rest.pop();
    return rows
      .filter(
        (row) =>
          row.committed &&
          rest.includes(row.type) &&
          (row.published_at > time ||
            (row.published_at.getTime() === time.getTime() && id !== null && row.id > id)),
      )
      .sort((a, b) => a.published_at - b.published_at || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  };
  const tx = { query };
  return {
    rows,
    database: { read: (work) => work(tx), transaction: (work) => work(tx) },
    tx,
  };
}

function message(id, publishedAt) {
  return {
    id,
    organization_id: 'org-1',
    type: 'message.created.v1',
    schema_version: 1,
    aggregate_type: 'message',
    aggregate_id: `m-${id}`,
    payload_json: JSON.stringify({ conversationId: 'conv-1', messageId: `m-${id}`, sequence: 7 }),
    correlation_id: null,
    occurred_at: publishedAt,
    attempts: 1,
    published_at: publishedAt,
    committed: false,
  };
}

const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => undefined };

test('two copies, one client each: both clients get the event, each exactly once', async () => {
  const outbox = sharedOutbox();
  const quiet = () => undefined;
  const copies = ['leader', 'follower'].map((name) => {
    const hub = new worker.RealtimeHub();
    const frames = [];
    hub.subscribe('org-1', 'conv-1', (frame) => frames.push(frame));
    const tail = startRealtimeTail({
      worker,
      database: outbox.database,
      hub,
      intervalMs: 1_000,
      log: quiet,
      describeError: String,
      timers: manualTimers,
    });
    return { name, hub, frames, tail };
  });
  for (const copy of copies) await copy.tail.poll();

  // The leader's relay delivers the event (side effects only), then the batch commits.
  const leader = copies[0];
  const relay = leaderRelayHandlers(worker, {}, outbox.database, leader.hub);
  const row = message('e1', new Date('2026-11-20T12:00:01.000Z'));
  outbox.rows.push(row);
  const event = {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    schemaVersion: 1,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: JSON.parse(row.payload_json),
    correlationId: null,
    occurredAt: row.occurred_at,
    attempts: 1,
  };
  const staged = [];
  await relay['message.created.v1'](event, outbox.tx, { afterCommit: (e) => staged.push(e) });
  row.committed = true;
  for (const effect of staged) await effect();

  // Several polls on each copy: the lookback re-reads the row, the id is framed once.
  for (let poll = 0; poll < 3; poll += 1) for (const copy of copies) await copy.tail.poll();

  for (const copy of copies) {
    assert.equal(copy.frames.length, 1, `${copy.name} client got ${copy.frames.length} frames`);
    assert.equal(copy.frames[0].eventType, 'message.created.v1');
    assert.equal(copy.frames[0].objectId, 'm-e1');
  }
});

test("the leader relay composes no chat or work frame: those come from every copy's tail", () => {
  const handlers = leaderRelayHandlers(
    worker,
    {},
    sharedOutbox().database,
    new worker.RealtimeHub(),
  );
  for (const type of ['direct_message.created.v1', ...worker.WORK_FRAME_EVENT_TYPES]) {
    assert.equal(handlers[type], undefined, `${type} has a relay handler`);
  }
});

test('server.mjs starts sockets and the tail on every copy, outside the leader lease', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const background = source.slice(source.indexOf('startBackground: async () => {'));
  const realtimeAt = background.indexOf('realtime = await startRealtime(');
  const leaderAt = background.indexOf('leadership = await startLeadership(');
  assert.ok(realtimeAt > 0 && leaderAt > 0, 'both calls present');
  assert.ok(realtimeAt < leaderAt, 'realtime starts before (outside) the leader callback');
  // Gated by the realtime switch alone — never by the lease.
  assert.match(
    background,
    /if \(realtimeInProcessEnabled\(process\.env\)\) \{\s+realtime = await startRealtime\(/u,
  );
  const relay = source.slice(
    source.indexOf('async function startInProcessWorker('),
    source.indexOf('async function startRealtime('),
  );
  assert.doesNotMatch(relay, /createRealtimeServer|createMessageFanOut|createRealtimeTail/u);
  assert.match(relay, /leaderRelayHandlers\(worker, relayHandlers, database, realtimeHub\)/u);
});
