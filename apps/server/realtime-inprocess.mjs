// The in-process realtime socket (H2, L5 NFR-06) — live pushes for the single Hostinger app.
//
// The standalone worker opens its socket server on `REALTIME_PORT`. The Hostinger app has exactly
// one public port, owned by server.mjs's HTTP server, so here the worker's socket server runs
// "attached": it binds nothing, and server.mjs hands it the WebSocket upgrades that arrive on
// `REALTIME_PATH`.
//
// DC-3 / RT-2: Hostinger often runs two copies of the app, and a socket lives on whichever copy
// the proxy gave its upgrade to. So the frames do NOT come from the relay (which runs on the
// leading copy only, RT-3): EVERY copy runs its own socket server and a realtime tail
// (`@tmanage/worker` `createRealtimeTail`) that follows the published outbox rows without claiming
// them and frames this copy's own sockets, each event once (idempotent consumer). The leader's
// relay keeps only the side effects ({@link leaderRelayHandlers}).
//
// The browser learns the socket URL from the API (`REALTIME_PUBLIC_URL`, served beside the
// ticket). When it is not set, it is derived from `WEB_PUBLIC_URL`: same origin, `wss://` for an
// `https://` site, path `REALTIME_PATH` — the one origin Hostinger terminates TLS for, so the
// page's `connect-src 'self'` admits it. A client that cannot connect keeps the refetch fallback
// it already has; nothing about the HTTP routes changes.
//
// On by default whenever the in-process relay runs (`WORKER_INPROCESS=1`): a socket with no relay
// would never receive a frame. `REALTIME_INPROCESS=0` (or false/off/no) turns it off.

import { clearInterval, setInterval } from 'node:timers';

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
 * The leader relay's handlers: the side-effect consumers plus link previews — and NO frames.
 * Frames come from every copy's realtime tail ({@link startRealtimeTail}); composing the fan-out
 * here as well would frame the leader's own sockets twice for every event (RT-2).
 *
 * The link-preview card is the one frame still published here, on the leader's hub only: it is
 * an after-commit effect with no outbox row behind it. A client on another copy gets the card
 * from its own refetch (the card polls with backoff until the preview is ready).
 */
export function leaderRelayHandlers(worker, handlers, database, hub) {
  return worker.withLinkPreviews(handlers, database, hub);
}

/**
 * DC-3 / RT-2 — this copy's realtime tail, polled every `intervalMs`. Never throws: a failed poll
 * (the database away, say) is logged and the next one retries; the first successful poll
 * fixes where the tail starts, so history is never replayed.
 */
export function startRealtimeTail({
  worker,
  database,
  hub,
  intervalMs,
  log,
  describeError,
  timers = { setInterval, clearInterval },
}) {
  const tail = worker.createRealtimeTail({
    database,
    handlers: worker.createRealtimeFanOutHandlers(hub),
    onHandlerError: (event, error) =>
      log(`realtime frame ${event.type} ${event.id} failed: ${describeError(error)}`),
  });
  const poll = async () => {
    try {
      const report = await tail.tick();
      if (report.truncated) log('realtime tail read its page limit; the next poll goes on');
      return report;
    } catch (error) {
      log(`realtime tail poll failed: ${describeError(error)}`);
      return undefined;
    }
  };
  const timer = timers.setInterval(() => void poll(), intervalMs);
  timer?.unref?.();
  return {
    poll,
    stop: () => timers.clearInterval(timer),
  };
}
