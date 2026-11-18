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
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { downloadFor, isApiPath } from './boot-guards.mjs';
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

/**
 * The `-H` the web child's `next start` gets (NOTFOUND500, live 2026-11-17).
 *
 * Next builds the URL its proxy sees as `<x-forwarded-proto>://localhost:<port>`, but decides
 * whether a proxy rewrite stays inside the server by comparing it with `<proto>://<-H>:<port>`.
 * With `-H 127.0.0.1` the two never matched, so every rewrite (the not-found page, the Markdown
 * twins) became an outbound fetch to `https://localhost:<port>`: TLS against a plain-http port
 * that, on Hostinger, is not even listening (the child is on a socket). Every unknown page
 * answered 500.
 *
 * On a socket or pipe the preload ignores the host, so `localhost` binds nothing public and makes
 * the two URLs agree. Loopback TCP (local development only) keeps `127.0.0.1`, the address
 * webTarget() connects to.
 */
export function webChildHost(transport) {
  return transport.kind === 'tcp' ? '127.0.0.1' : 'localhost';
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

/**
 * The public configuration the web child's `next start` needs: next.config re-runs its
 * public-config validation when it loads, so the same values the bundle build inlined must be
 * present. The /v1 rewrite they imply is never used (server.mjs answers /v1, and refuses its case
 * variants, before the web child sees it), so the proxy target is a placeholder on a privileged
 * port nothing of this account can listen on (NV05; the value the bundle build bakes in). The
 * deploy build loads the staged config with these same values (deploy/hostinger/build.mjs).
 */
export function webChildPublicConfig(parentEnv) {
  return {
    NEXT_PUBLIC_API_BASE_URL: parentEnv['NEXT_PUBLIC_API_BASE_URL'] ?? 'same-origin',
    NEXT_PUBLIC_SESSION_COOKIE_NAME:
      parentEnv['NEXT_PUBLIC_SESSION_COOKIE_NAME'] ?? 'tmanage_session',
    API_PROXY_TARGET: parentEnv['API_PROXY_TARGET'] ?? 'http://127.0.0.1:1',
  };
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

const NOT_FOUND_BODY = '{"statusCode":404,"code":"not_found","message":"Not found."}';
const BAD_REQUEST_BODY = '{"statusCode":400,"code":"bad_request","message":"Bad request."}';

/**
 * Security audit NV05. `isApiPath` decides the API boundary on the raw, case-sensitive
 * origin-form target, while `next start` matches its build-time `/v1/:path*` rewrite
 * case-insensitively, decodes percent-escapes and parses absolute-form targets. A target that
 * only Next would read as an API path must therefore never reach Next: an absolute-form (or
 * otherwise non-origin-form) target is a 400, and a case- or escape-variant of an API path
 * (`/V1/me`, `/%76%31/me`, `/MCP`) is a 404 from here.
 */
export function refusedPublicTarget(url) {
  const raw = String(url ?? '');
  if (!raw.startsWith('/')) return 400;
  if (isApiPath(raw)) return undefined;
  const path = raw.split('?')[0];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape: keep the raw path for the comparison below.
  }
  const folded = decoded
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (isApiPath(folded) || isApiPath(path.toLowerCase())) return 404;
  return undefined;
}

function answerRefused(res, status) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(status === 404 ? NOT_FOUND_BODY : BAD_REQUEST_BODY);
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) are never forwarded to the web child (security audit
 * NV06): `Connection`, `Upgrade`, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer` and any
 * header the client's `Connection` names. Only the realtime path upgrades, and it never reaches
 * the web child, so nothing the child receives can ask it to switch protocols.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'http2-settings',
]);

export function forwardableHeaders(headers) {
  const named = new Set(
    String(headers?.['connection'] ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/** How long a proxied exchange may sit with no bytes moving before both sides are closed. */
export const WEB_PROXY_IDLE_MS = 120_000;

/**
 * Tie the upstream request to the client's lifetime (security audit NV06): when the client goes
 * away, errors, or the exchange idles past `idleMs`, the upstream is destroyed, so no
 * parent-to-child socket outlives the request it served.
 */
export function bindProxyLifetimes(req, res, upstream, idleMs = WEB_PROXY_IDLE_MS) {
  const destroyUpstream = () => {
    if (!upstream.destroyed) upstream.destroy();
  };
  // A response that was sent in full leaves the upstream to its agent; any other close kills it.
  res.once('close', () => {
    if (!res.writableFinished) destroyUpstream();
  });
  req.once('error', destroyUpstream);
  upstream.setTimeout(idleMs, () => {
    if (res.writableFinished) return;
    upstream.destroy(new Error('web upstream idle timeout'));
    if (!res.destroyed) res.destroy();
  });
  upstream.once('upgrade', (_response, socket) => {
    // Never expected (no Upgrade header is forwarded); if it happens, nothing is relayed.
    socket.destroy();
    destroyUpstream();
    if (!res.destroyed) res.destroy();
  });
}

/**
 * The public request handler. `state.ready` is undefined until boot completes, then holds the
 * Fastify instance; until then EVERY path — /healthz included — answers 503 "starting", so a
 * health check reflects readiness rather than mere liveness.
 */
/**
 * Stream an allow-listed download (boot-guards.mjs `downloadFor`) from `dir`, or answer 503 when
 * this bundle was built without it. GET and HEAD only.
 */
export function serveDownload(req, res, download, dir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    res.end();
    return;
  }
  let size;
  const path = dir === undefined ? undefined : join(dir, download.file);
  try {
    const info = path === undefined ? undefined : statSync(path);
    if (info?.isFile()) size = info.size;
  } catch {
    // missing: answered below
  }
  if (path === undefined || size === undefined) {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"error":"download_unavailable"}');
    return;
  }
  res.writeHead(200, {
    'content-type': download.contentType,
    'content-length': String(size),
    'content-disposition': `attachment; filename="${download.file}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
}

/** `downloadsDir`: the bundle's downloads folder (server.mjs), or undefined where there is none. */
/**
 * FIX4 item 1a (live fe6b42bb: part PUTs answered 503). LiteSpeed starts a fresh instance of this
 * app after a deploy, after an idle stop, or beside a busy one, and routes requests to it at once.
 * An instance takes ~20 s to become ready (migrations check, Nest, the web child: 17:30:55 to
 * 17:31:16 on the live log), and until now it answered EVERY request in that window with 503
 * "starting" — an upload part, a message send, anything. A request that is not the liveness probe
 * now waits for readiness (up to {@link STARTUP_HOLD_MS}) and is then served as usual; only a
 * request still waiting at the end, or one over {@link STARTUP_HOLD_MAX} waiting at once, gets the
 * 503. The body is not read while it waits (the socket applies back-pressure), so a held upload
 * part reaches the API intact. `/healthz` still answers 503 at once: the monitor must see a
 * starting instance as starting.
 */
export const STARTUP_HOLD_MS = 30_000;
export const STARTUP_HOLD_MAX = 200;
const STARTUP_POLL_MS = 100;

export function createPublicHandler(
  state,
  proxyToWeb,
  downloadsDir = undefined,
  hold = { ms: STARTUP_HOLD_MS, max: STARTUP_HOLD_MAX },
) {
  let held = 0;
  const handle = (req, res) => {
    const ready = state.ready;
    if (!ready) {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/healthz' || hold.ms <= 0 || held >= hold.max) {
        answerStarting(res);
        return;
      }
      held += 1;
      const started = Date.now();
      let gone = false;
      const onClose = () => {
        gone = true;
      };
      req.once('close', onClose);
      const wait = () => {
        if (gone) {
          held -= 1;
          return;
        }
        if (state.ready) {
          held -= 1;
          req.off('close', onClose);
          handle(req, res);
          return;
        }
        if (Date.now() - started >= hold.ms) {
          held -= 1;
          req.off('close', onClose);
          answerStarting(res);
          return;
        }
        setTimeout(wait, STARTUP_POLL_MS);
      };
      setTimeout(wait, STARTUP_POLL_MS);
      return;
    }
    if ((req.url ?? '').split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"status":"ok"}');
      return;
    }
    const download = downloadFor(req.url);
    if (download !== undefined) {
      serveDownload(req, res, download, downloadsDir);
      return;
    }
    if (isApiPath(req.url)) {
      applyApiCacheDefault(res);
      ready.fastify.routing(req, res);
      return;
    }
    const refused = refusedPublicTarget(req.url);
    if (refused !== undefined) {
      answerRefused(res, refused);
      return;
    }
    proxyToWeb(req, res);
  };
  return handle;
}
