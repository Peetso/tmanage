// How server.mjs reaches its `next start` child, and what it answers while it is still starting.
// Kept apart from server.mjs so it can be unit-tested without starting the application.
//
// Two Hostinger (LiteSpeed lsnode) facts shape this file — both found on the live deploy of
// 2026-10-17 (deploy-live/LIVE-REPORT.md, fixes 2 and 3):
//
//   * lsnode restarts an app that has not called listen() on its PORT within ~3 s. Migrations,
//     Nest and `next start` take far longer, so server.mjs listens FIRST and answers every request
//     with 503 {"status":"starting"} (Retry-After) until the API and the web child are ready.
//   * Loopback TCP between the app's own processes is refused (the child's 127.0.0.1 port is
//     LISTEN in /proc/net/tcp, yet every connect gets ECONNREFUSED). So the web child listens on a
//     private Unix socket file under the app directory — directory 0700, socket 0600, removed on
//     start and on exit — and the parent proxies to that file.
//
// Local development keeps working on Windows: there the "socket" is a named pipe (Node supports
// both through the same `path` API), and TMANAGE_WEB_TRANSPORT=tcp restores the loopback port.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isApiPath } from './boot-guards.mjs';
import { applyApiCacheDefault } from './cache-headers.mjs';

/** Seconds a client is told to wait while the application is starting. */
export const STARTING_RETRY_AFTER_SECONDS = 5;
export const STARTING_BODY = '{"status":"starting"}';

/**
 * The longest socket path this file will use. sockaddr_un.sun_path is 108 bytes on Linux and 104
 * on macOS, including the terminating NUL; a longer path fails at bind() with an opaque error.
 */
export const MAX_SOCKET_PATH = 100;

/** The socket's file name inside its private directory. */
const SOCKET_NAME = 'web.sock';

/**
 * Decide how the parent reaches the web child.
 *
 * - `TMANAGE_WEB_TRANSPORT=tcp` (local development only): loopback TCP on WEB_INTERNAL_PORT,
 *   default PORT + 1 — the pre-hotfix behaviour.
 * - Windows: a named pipe with an unguessable name (`\\.\pipe\tmanage-web-<random>`).
 * - Otherwise: `<app dir>/.run/web.sock`, or TMANAGE_WEB_SOCKET when set. When the app-dir path
 *   would exceed the socket-path limit, a fresh 0700 directory under the OS temp dir is used
 *   instead (created at prepare time), so a deep install path never stops the boot.
 *
 * @returns {{ kind: 'tcp', port: number } |
 *           { kind: 'pipe', path: string } |
 *           { kind: 'socket', path: string | undefined, dir: string | undefined, temp: boolean }}
 */
export function resolveWebTransport({ env, platform, root, publicPort }) {
  const mode = (env['TMANAGE_WEB_TRANSPORT'] ?? '').trim().toLowerCase();
  if (mode === 'tcp') {
    const port = Number(env['WEB_INTERNAL_PORT'] ?? publicPort + 1);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`WEB_INTERNAL_PORT is not a valid port: ${env['WEB_INTERNAL_PORT']}`);
    }
    return { kind: 'tcp', port };
  }
  if (mode !== '' && mode !== 'socket') {
    throw new Error(`TMANAGE_WEB_TRANSPORT must be "socket" or "tcp", not "${mode}"`);
  }
  if (platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\tmanage-web-${randomBytes(12).toString('hex')}` };
  }
  const explicit = env['TMANAGE_WEB_SOCKET'];
  if (explicit) {
    const path = resolve(explicit);
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
      throw new Error(`TMANAGE_WEB_SOCKET is longer than ${MAX_SOCKET_PATH} bytes: ${path}`);
    }
    return { kind: 'socket', path, dir: undefined, temp: false };
  }
  const dir = join(root, '.run');
  const path = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) {
    return { kind: 'socket', path, dir, temp: false };
  }
  return { kind: 'socket', path: undefined, dir: undefined, temp: true };
}

/**
 * Make the socket's directory private and clear a socket a previous run left behind. Returns the
 * transport with its final path (the temp fallback only gets one here).
 */
export function prepareWebTransport(transport) {
  if (transport.kind !== 'socket') return transport;
  let { path, dir } = transport;
  if (transport.temp) {
    dir = mkdtempSync(join(tmpdir(), 'tmanage-web-'));
    path = join(dir, SOCKET_NAME);
  } else if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode is masked by the umask, and an existing directory keeps its old mode.
  if (dir) chmodSync(dir, 0o700);
  removeQuietly(path);
  return { ...transport, path, dir };
}

/** Remove the socket file (and a temp directory this run created). Safe to call twice. */
export function cleanupWebTransport(transport) {
  if (transport.kind !== 'socket' || !transport.path) return;
  removeQuietly(transport.path);
  if (transport.temp && transport.dir) {
    try {
      rmSync(transport.dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // nothing left over
  }
}

/** `http.request` options that reach the web child. */
export function webTarget(transport) {
  return transport.kind === 'tcp'
    ? { host: '127.0.0.1', port: transport.port }
    : { socketPath: transport.path };
}

/**
 * `net.createConnection` options that reach the web child. Not the same shape as webTarget():
 * `net` names a socket file `path`, while `http.request` names it `socketPath` (and treats `path`
 * as the URL path).
 */
export function webConnectTarget(transport) {
  return transport.kind === 'tcp'
    ? { host: '127.0.0.1', port: transport.port }
    : { path: transport.path };
}

/** A human-readable name for logs. */
export function describeWebTransport(transport) {
  return transport.kind === 'tcp' ? `127.0.0.1:${transport.port}` : transport.path;
}

/**
 * The environment the web child starts with. LiteSpeed's LSNODE_* variables are dropped so the
 * child is a plain server (lsnode would otherwise try to hand it the parent's socket), and the
 * socket path is passed to the preload that redirects the child's listen().
 */
export function webChildEnv(parentEnv, transport, nominalPort) {
  const out = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!key.startsWith('LSNODE')) out[key] = value;
  }
  delete out['TMANAGE_WEB_SOCKET'];
  if (transport.kind !== 'tcp') out['TMANAGE_WEB_SOCKET'] = transport.path;
  out['PORT'] = String(nominalPort);
  out['HOSTNAME'] = '127.0.0.1';
  return out;
}

/** Answer one request while the application is starting. */
export function answerStarting(res) {
  res.writeHead(503, {
    'content-type': 'application/json',
    'retry-after': String(STARTING_RETRY_AFTER_SECONDS),
    'cache-control': 'no-store',
  });
  res.end(STARTING_BODY);
}

/**
 * The public request handler. `state.ready` is undefined until boot completes, then holds the
 * Fastify instance; until then EVERY path — /healthz included — answers 503 "starting", so a
 * health check reflects readiness rather than mere liveness.
 */
export function createPublicHandler(state, proxyToWeb) {
  return (req, res) => {
    const ready = state.ready;
    if (!ready) {
      answerStarting(res);
      return;
    }
    if ((req.url ?? '').split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"status":"ok"}');
      return;
    }
    if (isApiPath(req.url)) {
      applyApiCacheDefault(res);
      ready.fastify.routing(req, res);
      return;
    }
    proxyToWeb(req, res);
  };
}
