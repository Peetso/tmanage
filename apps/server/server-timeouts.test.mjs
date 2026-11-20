// ST-3 — the public server's timeouts and the keep-alive contract of the web child hop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { UPLOAD_PART_SIZE_DEFAULT_BYTES } from '@tmanage/config';

import {
  createPublicServer,
  SERVER_TIMEOUTS,
  timeoutViolations,
  WEB_CHILD_KEEP_ALIVE_MS,
  WEB_UPSTREAM_AGENT,
  WEB_UPSTREAM_FREE_SOCKET_MS,
  webChildKeepAliveArgs,
} from './server-timeouts.mjs';
import { STARTUP_HOLD_MS } from './web-transport.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const SIZING = { startupHoldMs: STARTUP_HOLD_MS, uploadPartBytes: UPLOAD_PART_SIZE_DEFAULT_BYTES };

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((done) => server.close(() => done()));
}

/** A raw client socket, so the test controls exactly when each byte is sent. */
function rawClient(port) {
  return new Promise((done, fail) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => done(socket));
    socket.once('error', fail);
  });
}

function readUntil(socket, pattern, timeoutMs) {
  return new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error(`no ${String(pattern)} in ${text}`)), timeoutMs);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (pattern.test(text)) {
        clearTimeout(timer);
        done(text);
      }
    });
  });
}

function closedWithin(socket, timeoutMs) {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

test('ST-3: the shipped values keep every ordering', () => {
  assert.deepEqual(timeoutViolations(SIZING), []);
});

test('ST-3: the orderings catch Node defaults and the 120 s request limit', () => {
  // Node 22's own defaults: keep-alive 5 s (below a proxy's 60 s idle), headers 60 s checked
  // every 30 s.
  assert.deepEqual(
    timeoutViolations({
      ...SIZING,
      timeouts: {
        requestTimeout: 300_000,
        headersTimeout: 60_000,
        keepAliveTimeout: 5_000,
        connectionsCheckingInterval: 30_000,
      },
    }),
    [
      'keepAliveTimeout must exceed the proxy upstream idle time',
      'headersTimeout plus its checking interval must stay within 30 s',
    ],
  );
  // ENGINEERING-STANDARD ST-3's proposed 120 s would cut an 8 MiB part at the floor rate.
  assert.deepEqual(
    timeoutViolations({ ...SIZING, timeouts: { ...SERVER_TIMEOUTS, requestTimeout: 120_000 } }),
    ['requestTimeout must fit the startup hold plus one upload part at the floor rate'],
  );
  assert.deepEqual(
    timeoutViolations({ ...SIZING, childKeepAliveMs: WEB_UPSTREAM_FREE_SOCKET_MS }),
    ['the web child must keep idle connections longer than the parent agent'],
  );
});

test('ST-3: createPublicServer sets the three limits on the server', async () => {
  const server = createPublicServer((_req, res) => res.end('ok'));
  assert.equal(server.requestTimeout, 300_000);
  assert.equal(server.headersTimeout, 20_000);
  assert.equal(server.keepAliveTimeout, 65_000);
  await listen(server);
  await close(server);
});

test('ST-3: server.mjs builds its public server, web agent and web child from this module', () => {
  const source = readFileSync(join(HERE, 'server.mjs'), 'utf8');
  assert.match(source, /const server = createPublicServer\(/u);
  assert.doesNotMatch(source, /createServer as createHttpServer|createHttpServer\(/u);
  assert.match(source, /agent: WEB_UPSTREAM_AGENT,/u);
  assert.match(source, /\.\.\.webChildKeepAliveArgs\(\),/u);
});

test('ST-3: headers that never finish get 408 after headersTimeout (checked every interval)', async () => {
  const server = createPublicServer((_req, res) => res.end('ok'), {
    requestTimeout: 5_000,
    headersTimeout: 300,
    keepAliveTimeout: 2_000,
    connectionsCheckingInterval: 100,
  });
  const port = await listen(server);
  try {
    const socket = await rawClient(port);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    const started = Date.now();
    const answer = await readUntil(socket, /HTTP\/1\.1 408/u, 3_000);
    assert.match(answer, /^HTTP\/1\.1 408/u);
    assert.ok(Date.now() - started < 1_500, 'answered well before the default 60 s');
    socket.destroy();
  } finally {
    await close(server);
  }
});

test('ST-3: headersTimeout below keepAliveTimeout is safe: an idle keep-alive connection is reused', async () => {
  const server = createPublicServer((_req, res) => res.end('ok'), {
    requestTimeout: 5_000,
    headersTimeout: 300,
    keepAliveTimeout: 2_000,
    connectionsCheckingInterval: 100,
  });
  const port = await listen(server);
  try {
    const socket = await rawClient(port);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await readUntil(socket, /\r\n\r\nok$/u, 2_000);
    // Idle three headers-timeouts long, then a second request on the same connection.
    await sleep(900);
    socket.removeAllListeners('data');
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    const second = await readUntil(socket, /\r\n\r\nok$/u, 2_000);
    assert.match(second, /^HTTP\/1\.1 200/u);
    socket.destroy();
  } finally {
    await close(server);
  }
});

test('ST-3: an idle connection stays open for keepAliveTimeout, then closes', async () => {
  const server = createPublicServer((_req, res) => res.end('ok'), {
    requestTimeout: 5_000,
    headersTimeout: 1_000,
    keepAliveTimeout: 800,
    connectionsCheckingInterval: 100,
  });
  const port = await listen(server);
  try {
    const socket = await rawClient(port);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await readUntil(socket, /\r\n\r\nok$/u, 2_000);
    assert.equal(await closedWithin(socket, 600), false, 'still open before keepAliveTimeout');
    assert.equal(await closedWithin(socket, 3_000), true, 'closed after it');
  } finally {
    await close(server);
  }
});

test('ST-3: the web hop agent pools connections and drops idle ones on its own timer', async () => {
  assert.equal(WEB_UPSTREAM_AGENT.keepAlive, true);
  assert.equal(WEB_UPSTREAM_AGENT.options.timeout, WEB_UPSTREAM_FREE_SOCKET_MS);
  // The mechanism, with short values: a pooled idle socket is destroyed by the agent's timeout
  // while the server would still have kept it.
  const child = createServer({ keepAliveTimeout: 5_000 }, (_req, res) => res.end('ok'));
  const port = await listen(child);
  const agent = new Agent({ keepAlive: true, timeout: 200 });
  try {
    await new Promise((done, fail) => {
      const req = request({ host: '127.0.0.1', port, agent, path: '/' }, (res) => {
        res.resume();
        res.once('end', done);
      });
      req.once('error', fail);
      req.end();
    });
    await sleep(50);
    assert.equal(Object.values(agent.freeSockets).flat().length, 1, 'pooled after the response');
    await sleep(600);
    assert.equal(Object.values(agent.freeSockets).flat().length, 0, 'dropped by the agent');
  } finally {
    agent.destroy();
    await close(child);
  }
});

test('ST-3: the web child is told to keep idle connections longer than the agent', () => {
  assert.deepEqual(webChildKeepAliveArgs(), [
    '--keepAliveTimeout',
    String(WEB_CHILD_KEEP_ALIVE_MS),
  ]);
  assert.ok(WEB_CHILD_KEEP_ALIVE_MS > WEB_UPSTREAM_FREE_SOCKET_MS);
  // The installed `next start` accepts the flag (a Next upgrade that drops it fails here).
  const require = createRequire(import.meta.url);
  const nextBin = readFileSync(require.resolve('next/dist/bin/next'), 'utf8');
  assert.match(nextBin, /--keepAliveTimeout <keepAliveTimeout>/u);
});
