import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  cleanupWebTransport,
  createPublicHandler,
  MAX_SOCKET_PATH,
  prepareWebTransport,
  resolveWebTransport,
  STARTING_BODY,
  webChildEnv,
  webConnectTarget,
  webTarget,
} from './web-transport.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const POSIX = process.platform !== 'win32';

function get(server, path) {
  const { port } = server.address();
  return new Promise((done, fail) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
    })
      .on('error', fail)
      .end();
  });
}

function listen(handler) {
  const server = createServer(handler);
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

test('until ready, every path (healthz and /v1 included) answers 503 starting with Retry-After', async () => {
  const routed = [];
  const state = { ready: undefined };
  const server = await listen(
    createPublicHandler(state, (_req, res) => {
      routed.push('web');
      res.end('web');
    }),
  );
  try {
    for (const path of ['/', '/healthz', '/healthz?x=1', '/v1/auth/password', '/sign-in']) {
      const res = await get(server, path);
      assert.equal(res.status, 503, path);
      assert.equal(res.body, STARTING_BODY, path);
      assert.equal(res.headers['retry-after'], '5', path);
      assert.equal(res.headers['cache-control'], 'no-store', path);
    }
    assert.deepEqual(routed, []);

    state.ready = {
      fastify: {
        routing: (_req, res) => {
          routed.push('api');
          res.end('api');
        },
      },
    };
    const health = await get(server, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body, '{"status":"ok"}');
    assert.equal((await get(server, '/v1/auth/password')).body, 'api');
    assert.equal((await get(server, '/sign-in')).body, 'web');
    assert.deepEqual(routed, ['api', 'web']);
  } finally {
    server.close();
  }
});

test('the transport: socket under the app dir by default, named pipe on Windows, TCP only on request', () => {
  const root = '/home/u1/domains/tmanage.example.com/nodejs';
  assert.deepEqual(resolveWebTransport({ env: {}, platform: 'linux', root, publicPort: 3000 }), {
    kind: 'socket',
    path: join(root, '.run', 'web.sock'),
    dir: join(root, '.run'),
    temp: false,
  });

  const pipe = resolveWebTransport({ env: {}, platform: 'win32', root, publicPort: 3000 });
  assert.equal(pipe.kind, 'pipe');
  assert.match(pipe.path, /^\\\\\.\\pipe\\tmanage-web-[0-9a-f]{24}$/);

  assert.deepEqual(
    resolveWebTransport({
      env: { TMANAGE_WEB_TRANSPORT: 'tcp' },
      platform: 'win32',
      root,
      publicPort: 3000,
    }),
    { kind: 'tcp', port: 3001 },
  );
  assert.deepEqual(
    resolveWebTransport({
      env: { TMANAGE_WEB_TRANSPORT: 'TCP', WEB_INTERNAL_PORT: '4100' },
      platform: 'linux',
      root,
      publicPort: 3000,
    }),
    { kind: 'tcp', port: 4100 },
  );
  assert.throws(
    () =>
      resolveWebTransport({
        env: { TMANAGE_WEB_TRANSPORT: 'udp' },
        platform: 'linux',
        root,
        publicPort: 3000,
      }),
    /must be "socket" or "tcp"/,
  );
  assert.throws(
    () =>
      resolveWebTransport({
        env: { TMANAGE_WEB_TRANSPORT: 'tcp', WEB_INTERNAL_PORT: 'x' },
        platform: 'linux',
        root,
        publicPort: 3000,
      }),
    /not a valid port/,
  );
});

test('a path too long for a socket falls back to a private temp directory, never fails the boot', () => {
  const root = `/home/${'a'.repeat(MAX_SOCKET_PATH)}`;
  const transport = resolveWebTransport({ env: {}, platform: 'linux', root, publicPort: 3000 });
  assert.equal(transport.temp, true);
  assert.equal(transport.path, undefined);
  assert.throws(
    () =>
      resolveWebTransport({
        env: { TMANAGE_WEB_SOCKET: join(root, 's.sock') },
        platform: 'linux',
        root,
        publicPort: 3000,
      }),
    /longer than/,
  );

  const prepared = prepareWebTransport(transport);
  try {
    assert.ok(prepared.path.startsWith(prepared.dir));
    assert.ok(existsSync(prepared.dir));
    if (POSIX) assert.equal(statSync(prepared.dir).mode & 0o777, 0o700);
  } finally {
    cleanupWebTransport(prepared);
  }
  assert.equal(existsSync(prepared.dir), false);
});

test('prepare makes the directory 0700 and removes a stale socket; cleanup removes the socket', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-wt-'));
  try {
    const transport = resolveWebTransport({ env: {}, platform: 'linux', root, publicPort: 3000 });
    const first = prepareWebTransport(transport);
    writeFileSync(first.path, 'stale');
    const prepared = prepareWebTransport(transport);
    assert.equal(existsSync(prepared.path), false);
    if (POSIX) assert.equal(statSync(prepared.dir).mode & 0o777, 0o700);
    writeFileSync(prepared.path, 'left');
    cleanupWebTransport(prepared);
    cleanupWebTransport(prepared);
    assert.equal(existsSync(prepared.path), false);
    assert.equal(existsSync(prepared.dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the child environment drops LiteSpeed variables and names the socket', () => {
  const env = webChildEnv(
    {
      PATH: '/bin',
      LSNODE_SOCKET: '/x',
      LSNODE_ROOT: '/y',
      PORT: '3000',
      TMANAGE_WEB_SOCKET: '/old',
    },
    { kind: 'socket', path: '/app/.run/web.sock' },
    3001,
  );
  assert.deepEqual(env, {
    PATH: '/bin',
    PORT: '3001',
    HOSTNAME: '127.0.0.1',
    TMANAGE_WEB_SOCKET: '/app/.run/web.sock',
  });
  const tcp = webChildEnv({ TMANAGE_WEB_SOCKET: '/old' }, { kind: 'tcp', port: 4100 }, 4100);
  assert.equal(tcp['TMANAGE_WEB_SOCKET'], undefined);
  assert.deepEqual(webTarget({ kind: 'tcp', port: 4100 }), { host: '127.0.0.1', port: 4100 });
  assert.deepEqual(webTarget({ kind: 'socket', path: '/s' }), { socketPath: '/s' });
  // net.createConnection names the socket file `path`; `socketPath` would be ignored by it.
  assert.deepEqual(webConnectTarget({ kind: 'tcp', port: 4100 }), {
    host: '127.0.0.1',
    port: 4100,
  });
  assert.deepEqual(webConnectTarget({ kind: 'socket', path: '/s' }), { path: '/s' });
});

test('the preload moves the child listen() on its nominal port onto the private socket (0600)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-wp-'));
  const transport = prepareWebTransport(
    resolveWebTransport({ env: {}, platform: process.platform, root, publicPort: 39_870 }),
  );
  const nominalPort = 39_871;
  const script = join(root, 'child.mjs');
  writeFileSync(
    script,
    [
      "import { createServer } from 'node:http';",
      "createServer((_q, r) => r.end('from-child')).listen(Number(process.env.PORT), '127.0.0.1',",
      "  () => process.stdout.write('LISTENING\\n'));",
    ].join('\n'),
  );
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(resolve(HERE, 'web-socket-preload.mjs')).href, script],
    { env: webChildEnv(process.env, transport, nominalPort), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await new Promise((done, fail) => {
      child.stdout.on('data', (chunk) => String(chunk).includes('LISTENING') && done());
      child.once('exit', (code) => fail(new Error(`child exited ${code}`)));
    });
    // The readiness probe server.mjs uses (net.createConnection) reaches the child too.
    await new Promise((done, fail) => {
      const probe = createConnection(webConnectTarget(transport));
      probe.once('connect', () => {
        probe.destroy();
        done();
      });
      probe.once('error', fail);
    });
    const body = await new Promise((done, fail) => {
      request({ ...webTarget(transport), path: '/' }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done(text));
      })
        .on('error', fail)
        .end();
    });
    assert.equal(body, 'from-child');
    if (POSIX) assert.equal(statSync(transport.path).mode & 0o777, 0o600);
    // Nothing listens on the nominal TCP port.
    const tcp = await new Promise((done) => {
      const socket = createConnection(nominalPort, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        done('connected');
      });
      socket.once('error', (error) => done(error.code));
    });
    assert.equal(tcp, 'ECONNREFUSED');
  } finally {
    child.removeAllListeners('exit');
    child.kill();
    await new Promise((done) => (child.exitCode !== null ? done() : child.once('exit', done)));
    cleanupWebTransport(transport);
    rmSync(root, { recursive: true, force: true });
  }
});
