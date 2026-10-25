// The in-process realtime socket (H2, L5 NFR-06) — live pushes for the single Hostinger app.
//
// The standalone worker opens its socket server on `REALTIME_PORT`. The Hostinger app has exactly
// one public port, owned by server.mjs's HTTP server, so here the worker's socket server runs
// "attached": it binds nothing, and server.mjs hands it the WebSocket upgrades that arrive on
// `REALTIME_PATH`. The in-process relay then fans `message.created.v1` and
// `direct_message.created.v1` out to the subscribed sockets, exactly as the standalone loop does.
//
// The browser learns the socket URL from the API (`REALTIME_PUBLIC_URL`, served beside the
// ticket). When it is not set, it is derived from `WEB_PUBLIC_URL`: same origin, `wss://` for an
// `https://` site, path `REALTIME_PATH` — the one origin Hostinger terminates TLS for, so the
// page's `connect-src 'self'` admits it. A client that cannot connect keeps the refetch fallback
// it already has; nothing about the HTTP routes changes.
//
// On by default whenever the in-process relay runs (`WORKER_INPROCESS=1`): a socket with no relay
// would never receive a frame. `REALTIME_INPROCESS=0` (or false/off/no) turns it off.

/** The path the browser opens the socket on. Not under `/v1`, so it never reaches the API router. */
export const REALTIME_PATH = '/realtime';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Whether this process attaches the realtime socket: the relay must run here, and not opted out. */
export function realtimeInProcessEnabled(env) {
  if (env['WORKER_INPROCESS'] !== '1') return false;
  const raw = String(env['REALTIME_INPROCESS'] ?? '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.has(raw);
}

/**
 * The socket URL for a site URL: same host, `wss:` for `https:` (`ws:` for a local `http:`),
 * `REALTIME_PATH`. `undefined` when the site URL is missing or not http(s) — then no URL is
 * served and clients stay on refetch, rather than being sent to a guessed address.
 */
export function realtimePublicUrlFor(webPublicUrl) {
  if (typeof webPublicUrl !== 'string' || webPublicUrl.trim() === '') return undefined;
  let url;
  try {
    url = new URL(webPublicUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}${REALTIME_PATH}`;
}

/**
 * Settle `REALTIME_PUBLIC_URL` before the environment is validated: an operator's own value is
 * kept; otherwise the derived same-origin one is set. Returns a note for the log (no secrets).
 */
export function applyRealtimePublicUrl(env) {
  if (!realtimeInProcessEnabled(env))
    return 'realtime socket off (WORKER_INPROCESS/REALTIME_INPROCESS)';
  if (typeof env['REALTIME_PUBLIC_URL'] === 'string' && env['REALTIME_PUBLIC_URL'].trim() !== '') {
    return 'realtime socket on (REALTIME_PUBLIC_URL as configured)';
  }
  const derived = realtimePublicUrlFor(env['WEB_PUBLIC_URL']);
  if (derived === undefined) return 'realtime socket on, but no public URL (WEB_PUBLIC_URL unset)';
  env['REALTIME_PUBLIC_URL'] = derived;
  return `realtime socket on at ${derived}`;
}

/** Whether an upgrade request is for the realtime socket (the query carries the ticket). */
export function isRealtimeUpgrade(requestUrl) {
  return String(requestUrl ?? '').split('?')[0] === REALTIME_PATH;
}

/**
 * The `upgrade` listener for the public HTTP server. Hands realtime upgrades to the socket
 * server once it exists and the app is ready; refuses everything else by closing the socket
 * (nothing else on this app speaks WebSocket). `getRealtime` returns the attached server or
 * `undefined` while booting or when realtime is off.
 */
export function createUpgradeHandler(getRealtime) {
  return (request, socket, head) => {
    const realtime = getRealtime();
    if (realtime === undefined || !isRealtimeUpgrade(request.url)) {
      socket.destroy();
      return;
    }
    realtime.handleUpgrade(request, socket, head);
  };
}

/**
 * The outbox handlers with the realtime fan-out composed in — mention notices first, then the
 * frame, the same `both(...)` composition the standalone worker loop uses (CQ-12, BK3-left).
 */
export function withRealtimeFanOut(worker, handlers, hub) {
  const fanOut = worker.createMessageFanOut(hub);
  const directFanOut = worker.createDirectMessageFanOut(hub);
  const mentions = handlers['message.created.v1'];
  const directNotices = handlers['direct_message.created.v1'];
  return {
    ...handlers,
    'message.created.v1': mentions === undefined ? fanOut : worker.both(mentions, fanOut),
    'direct_message.created.v1':
      directNotices === undefined ? directFanOut : worker.both(directNotices, directFanOut),
  };
}
