import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { clearTimeout } from 'node:timers';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createUpgradeHandler } from './realtime-inprocess.mjs';
import {
  bindProxyLifetimes,
  cleanupWebTransport,
  createPublicHandler,
  forwardableHeaders,
  MAX_SOCKET_PATH,
  prepareWebTransport,
  refusedPublicTarget,
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

/** Send one raw HTTP/1.1 request and collect whatever comes back until the server closes. */
function raw(server, text, waitMs = 1500) {
  const { port } = server.address();
  return new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(text));
    let body = '';
    const timer = setTimeout(() => {
      socket.destroy();
      done({ body, closed: false });
    }, waitMs);
    socket.on('data', (chunk) => (body += chunk));
    socket.on('close', () => {
      clearTimeout(timer);
      done({ body, closed: true });
    });
    socket.on('error', fail);
  });
}

function readyState(routed) {
  return {
    ready: {
      fastify: {
        routing: (_req, res) => {
          routed.push('api');
          res.end('api');
        },
      },
    },
  };
}

test('NV05: case and escape variants of API paths are 404 here, never proxied to the web child', async () => {
  const routed = [];
  const server = await listen(
    createPublicHandler(readyState(routed), (_req, res) => {
      routed.push('web');
      res.end('web');
    }),
  );
  try {
    for (const path of [
      '/V1/me',
      '/V1',
      '/v1%2Fme',
      '/%76%31/me',
      '/%56%31/me',
      '/MCP',
      '/Public/Site/x',
    ]) {
      const res = await get(server, path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers['cache-control'], 'no-store', path);
    }
    assert.deepEqual(routed, [], 'nothing reached the API router or the web proxy');

    // The real API path still goes to the API, and pages still go to the web child.
    assert.equal((await get(server, '/v1/me')).body, 'api');
    assert.equal((await get(server, '/sign-in')).body, 'web');
    assert.equal((await get(server, '/v1x')).body, 'web');
    assert.deepEqual(routed, ['api', 'web', 'web']);
  } finally {
    server.close();
  }
});

test('NV05: an absolute-form request-target is refused (400), never handed to Next', async () => {
  const routed = [];
  const server = await listen(
    createPublicHandler(readyState(routed), (_req, res) => {
      routed.push('web');
      res.end('web');
    }),
  );
  try {
    const { port } = server.address();
    const res = await raw(
      server,
      `GET http://127.0.0.1:${port}/v1/me HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: tmanage_session=dummy\r\nConnection: close\r\n\r\n`,
    );
    assert.match(res.body, /^HTTP\/1\.1 400 /);
    assert.deepEqual(routed, []);
  } finally {
    server.close();
  }
  assert.equal(refusedPublicTarget('*'), 400);
  assert.equal(refusedPublicTarget('/v1/me'), undefined);
  assert.equal(refusedPublicTarget('/V1/me?x=1'), 404);
  assert.equal(
    refusedPublicTarget('/%E0%A4%A'),
    undefined,
    'a malformed escape is not an API path',
  );
});

test('NV06: 20 raw Upgrade requests to a non-websocket path leave no socket open and reach no upstream', async () => {
  const routed = [];
  const server = createServer(
    createPublicHandler(readyState(routed), (_req, res) => {
      routed.push('web');
      res.end('web');
    }),
  );
  server.on(
    'upgrade',
    createUpgradeHandler(() => undefined),
  );
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_v, i) =>
        raw(
          server,
          `GET /no-such-page-${i} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ),
      ),
    );
    for (const result of results) assert.equal(result.closed, true, 'the server closed it');
    assert.deepEqual(routed, [], 'no Upgrade reached the web proxy');
    const open = await new Promise((done) => server.getConnections((_e, n) => done(n)));
    assert.equal(open, 0);
  } finally {
    server.close();
  }
});

test('NV06: hop-by-hop headers are not forwarded to the web child', () => {
  const out = forwardableHeaders({
    host: 'x',
    connection: 'Upgrade, X-Secret-Hop',
    upgrade: 'websocket',
    'keep-alive': 'timeout=5',
    'proxy-connection': 'keep-alive',
    te: 'trailers',
    'x-secret-hop': '1',
    cookie: 'a=b',
    'sec-websocket-key': 'k',
  });
  assert.deepEqual(Object.keys(out).sort(), ['cookie', 'host', 'sec-websocket-key']);
});

test('NV06: the upstream is destroyed when the client goes away or the exchange idles', async () => {
  // A web child that never answers: the upstream would hang for ever without the binding.
  const sockets = new Set();
  const child = createServer(() => {});
  child.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done) => child.listen(0, '127.0.0.1', done));
  const childPort = child.address().port;
  const front = createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port: childPort, path: req.url, method: 'GET' });
    upstream.on('error', () => {});
    bindProxyLifetimes(req, res, upstream, req.url === '/idle' ? 300 : 60_000);
    upstream.end();
  });
  await new Promise((done) => front.listen(0, '127.0.0.1', done));
  try {
    // Client hangs up early (idle limit a minute away): the close alone frees the upstream.
    const early = await raw(front, 'GET /hang HTTP/1.1\r\nHost: x\r\n\r\n', 150);
    assert.equal(early.closed, false);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sockets.size, 0, 'the client close destroyed the upstream');
    // Idle: the client stays, the binding closes both sides after 300 ms.
    const idle = await raw(front, 'GET /idle HTTP/1.1\r\nHost: x\r\n\r\n', 3000);
    assert.equal(idle.closed, true, 'the idle exchange was closed');
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(sockets.size, 0, 'no parent-to-child socket outlived its request');
  } finally {
    front.close();
    child.close();
  }
});

test('the desktop installer is served from the downloads folder as octet-stream; 503 when absent', async () => {
  const routed = [];
  const dir = mkdtempSync(join(tmpdir(), 'tm-dl-'));
  writeFileSync(join(dir, 'TManage-Setup.exe'), 'MZ-installer');
  const served = await listen(createPublicHandler(readyState(routed), () => {}, dir));
  const missing = await listen(createPublicHandler(readyState(routed), () => {}, undefined));
  try {
    const res = await get(served, '/downloads/TManage-Setup.exe');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.body, 'MZ-installer');
    assert.equal((await get(served, '/downloads/TManage-Setup.exe.sha256')).status, 503);
    assert.equal((await get(missing, '/downloads/TManage-Setup.exe')).status, 503);
    // The AI connector bridge's checksum is served from the same folder; the tarball goes to the API.
    writeFileSync(join(dir, 'tmanage-mcp.tgz.sha256'), 'abc  tmanage-mcp.tgz\n');
    const sum = await get(served, '/downloads/tmanage-mcp.tgz.sha256');
    assert.equal(sum.status, 200);
    assert.equal(sum.body, 'abc  tmanage-mcp.tgz\n');
    assert.deepEqual(routed, []);
  } finally {
    served.close();
    missing.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
