import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REALTIME_PATH,
  applyRealtimePublicUrl,
  createUpgradeHandler,
  isRealtimeUpgrade,
  realtimeInProcessEnabled,
  realtimePublicUrlFor,
  withRealtimeFanOut,
} from './realtime-inprocess.mjs';

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

test('the fan-out is composed after the existing handlers, as the worker loop does', async () => {
  const calls = [];
  const worker = {
    createMessageFanOut: () => async () => calls.push('fan-out'),
    createDirectMessageFanOut: () => async () => calls.push('direct-fan-out'),
    both: (first, second) => async (event) => {
      await first(event);
      await second(event);
    },
  };
  const handlers = {
    'message.created.v1': async () => calls.push('mentions'),
    'client_request.submitted.v1': async () => calls.push('mail'),
  };

  const composed = withRealtimeFanOut(worker, handlers, {});
  await composed['message.created.v1']({});
  await composed['direct_message.created.v1']({});
  await composed['client_request.submitted.v1']({});

  assert.deepEqual(calls, ['mentions', 'fan-out', 'direct-fan-out', 'mail']);
});
