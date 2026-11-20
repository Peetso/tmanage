// ST-3 — the public HTTP server's timeouts, and the keep-alive contract of the hop to the web child.
//
// Two hops carry every page request, and each has a client that pools idle connections and a
// server that closes them:
//
//   browser → Hostinger's proxy → THIS server (public port)  → web child `next start` (socket)
//                     client ───────── server       client ──────── server
//
// The rule for a pooled hop is that the SERVER must keep an idle connection open LONGER than the
// CLIENT does. Otherwise the server closes a connection at the moment the client sends the next
// request on it, and the client answers 502 (AWS ELB docs, "Connection idle timeout": "configure
// the idle timeout of your application to be larger than the idle timeout configured for the load
// balancer. Otherwise, … the load balancer sends an HTTP 502"). Node's own default
// `keepAliveTimeout` is 5 s, far below a typical proxy's upstream idle time (nginx
// `keepalive_timeout` default 60 s in the upstream module; ELB 60 s), so the defaults invite that
// race on both hops.
//
// Values (Node 22 docs, `http.createServer` options; defaults in brackets):
//
//   * keepAliveTimeout 65 s [5 s]  — above the 60 s idle time common to proxies. Hostinger does not
//     publish its proxy's upstream idle time (unverified; lane K report §3), so 60 s is the
//     documented industry default this has to beat. Node 22.19+ adds `keepAliveTimeoutBuffer`
//     (1 s) on top. A server closing idle connections later costs only idle sockets the proxy
//     already chose to keep; `server.close()` still closes idle ones at once (Node ≥ 19).
//   * headersTimeout 20 s [60 s]   — the proxy sends a request's headers in one go; 20 s is ample.
//     Node measures it from the start of each request, not from the last response, so it may be
//     shorter than keepAliveTimeout (proven in server-timeouts.test.mjs).
//   * connectionsCheckingInterval 5 s [30 s] — how often Node enforces the two limits above; with
//     the default the effective headers limit could reach 20 + 30 s.
//   * requestTimeout 300 s [300 s] — the whole request, body included. Kept at Node's default on
//     purpose, now stated: the longest legitimate request is an upload part (8 MiB by default,
//     `UPLOAD_PART_SIZE_DEFAULT_BYTES`), possibly held up to 30 s first while the app starts
//     (`STARTUP_HOLD_MS`). At a 64 KiB/s floor that needs 30 + 128 s; ENGINEERING-STANDARD's
//     proposed 120 s would cut slow uploads. Node documents the limit as DoS protection "in case
//     the server is deployed without a reverse proxy in front", which is not our shape.
//
// The web child hop: the parent pools connections to `next start` through WEB_UPSTREAM_AGENT
// (keep-alive, idle sockets dropped after 5 s, the same as Node's `http.globalAgent`), and the
// child is started with `--keepAliveTimeout` 65 s, so the child never closes an idle connection
// the parent may still reuse, whatever the Node 22 minor version (the agent's own 1 s hint buffer
// exists only from 22.20).
import { Agent, createServer } from 'node:http';

/** The public server's limits (see the file comment for each value and its source). */
export const SERVER_TIMEOUTS = Object.freeze({
  requestTimeout: 300_000,
  headersTimeout: 20_000,
  keepAliveTimeout: 65_000,
  connectionsCheckingInterval: 5_000,
});

/** The upstream idle time a proxy is assumed to keep (nginx upstream default, ELB default). */
export const PROXY_UPSTREAM_IDLE_ASSUMED_MS = 60_000;
/** How long the parent keeps an idle connection to the web child before dropping it. */
export const WEB_UPSTREAM_FREE_SOCKET_MS = 5_000;
/** How long the web child keeps an idle connection open (`next start --keepAliveTimeout`). */
export const WEB_CHILD_KEEP_ALIVE_MS = 65_000;

/** The slowest upload a request must still fit, at the default part size. */
export const UPLOAD_FLOOR_BYTES_PER_SECOND = 64 * 1024;

/**
 * The public HTTP server with {@link SERVER_TIMEOUTS}. `timeouts` is overridable only so tests can
 * prove the behaviour with short values.
 */
export function createPublicServer(listener, timeouts = SERVER_TIMEOUTS) {
  return createServer({ ...timeouts }, listener);
}

/** The pooled agent for the hop to the web child (keep-alive, short idle). */
export const WEB_UPSTREAM_AGENT = new Agent({
  keepAlive: true,
  timeout: WEB_UPSTREAM_FREE_SOCKET_MS,
});

/** The `next start` flags that make the child outlast the parent's idle sockets. */
export function webChildKeepAliveArgs() {
  return ['--keepAliveTimeout', String(WEB_CHILD_KEEP_ALIVE_MS)];
}

/**
 * Every ordering the values above must keep; an empty list means they hold. Pure, so the test can
 * also prove that a wrong value (such as a 120 s request limit or a 5 s keep-alive) is caught.
 */
export function timeoutViolations({
  timeouts = SERVER_TIMEOUTS,
  proxyIdleMs = PROXY_UPSTREAM_IDLE_ASSUMED_MS,
  startupHoldMs,
  uploadPartBytes,
  floorBytesPerSecond = UPLOAD_FLOOR_BYTES_PER_SECOND,
  childKeepAliveMs = WEB_CHILD_KEEP_ALIVE_MS,
  upstreamFreeSocketMs = WEB_UPSTREAM_FREE_SOCKET_MS,
}) {
  const out = [];
  if (!(timeouts.keepAliveTimeout > proxyIdleMs)) {
    out.push('keepAliveTimeout must exceed the proxy upstream idle time');
  }
  if (!(timeouts.headersTimeout > 0 && timeouts.headersTimeout <= timeouts.requestTimeout)) {
    out.push('headersTimeout must be set and at most requestTimeout');
  }
  if (!(timeouts.headersTimeout + timeouts.connectionsCheckingInterval <= 30_000)) {
    out.push('headersTimeout plus its checking interval must stay within 30 s');
  }
  const uploadMs = startupHoldMs + (uploadPartBytes / floorBytesPerSecond) * 1_000;
  if (!(timeouts.requestTimeout >= uploadMs)) {
    out.push('requestTimeout must fit the startup hold plus one upload part at the floor rate');
  }
  if (!(childKeepAliveMs >= upstreamFreeSocketMs + 1_000)) {
    out.push('the web child must keep idle connections longer than the parent agent');
  }
  return out;
}
