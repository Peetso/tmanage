/**
 * Local load test against the planning pack's performance targets. See README.md.
 *
 *   node scripts/load/run.mjs --world world.json [--duration 20] [--connections 10]
 *
 * Signs in seeded test users, hits the main read routes and one write route for a fixed time
 * each, prints p50/p95/p99 and errors per route against its target, and exits 1 on any miss
 * (2 on a setup error). It refuses any API that is not a local development host.
 *
 * Optional: `--fill-work` / `--fill-messages` grow the seed through the API first (the seed is a
 * handful of rows; the budgets are about a working tenant), and `--realtime-sockets` adds the
 * NFR-06 fan-out probe: that many subscribed sockets, a series of posted messages, and the time
 * from each POST to each socket's frame.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { clearTimeout } from 'node:timers';
import { parseArgs } from 'node:util';

import {
  DEFAULT_MAX_ERROR_RATE,
  REALTIME_FRAME_TIMEOUT_MS,
  REALTIME_P95_MS,
  REALTIME_ROUTE,
  WRITE_P95_MS,
  buildRoutes,
  cookieHeaderFrom,
  evaluate,
  fanOutSamples,
  formatReport,
  isLocalTarget,
  summarise,
} from './load-plan.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: 'string', default: 'http://localhost:3001' },
      origin: { type: 'string', default: 'http://localhost:3000' },
      org: { type: 'string', default: 'northstar-studio' },
      world: { type: 'string' },
      'user-id': { type: 'string', multiple: true },
      email: { type: 'string', multiple: true },
      project: { type: 'string' },
      'work-item': { type: 'string' },
      search: { type: 'string' },
      duration: { type: 'string', default: '20' },
      warmup: { type: 'string', default: '2' },
      connections: { type: 'string', default: '10' },
      only: { type: 'string' },
      'max-error-rate': { type: 'string', default: String(DEFAULT_MAX_ERROR_RATE) },
      'write-p95': { type: 'string', default: String(WRITE_P95_MS) },
      json: { type: 'string' },
      'fill-work': { type: 'string', default: '0' },
      'fill-messages': { type: 'string', default: '0' },
      'realtime-sockets': { type: 'string', default: '0' },
      'realtime-messages': { type: 'string', default: '20' },
      'realtime-gap': { type: 'string', default: '1500' },
      'realtime-p95': { type: 'string', default: String(REALTIME_P95_MS) },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log('See scripts/load/README.md for every option.');
    return 0;
  }

  const api = values.api.replace(/\/+$/, '');
  if (!isLocalTarget(api) || !isLocalTarget(values.origin)) {
    throw new SetupError(
      `Refusing ${api}: the load test only runs against a local development host ` +
        '(localhost, 127.0.0.1, ::1, *.localhost, *.test).',
    );
  }

  const durationS = positive(values.duration, '--duration');
  const warmupS = nonNegative(values.warmup, '--warmup');
  const connections = Math.floor(positive(values.connections, '--connections'));
  const maxErrorRate = nonNegative(values['max-error-rate'], '--max-error-rate');
  const writeP95 = positive(values['write-p95'], '--write-p95');

  const world = values.world ? JSON.parse(readFileSync(values.world, 'utf8')) : undefined;
  const tenant = world?.northstar;
  const userIds = [
    ...(values['user-id'] ?? []),
    ...(tenant ? [tenant.owner?.id, tenant.manager?.id, tenant.designer?.id].filter(Boolean) : []),
  ];
  const emails = values.email ?? [];
  const password = process.env['LOAD_PASSWORD'];
  if (emails.length > 0 && !password) {
    throw new SetupError('--email needs the password in the LOAD_PASSWORD environment variable.');
  }
  if (userIds.length === 0 && emails.length === 0) {
    throw new SetupError('No users to sign in: pass --world, --user-id or --email.');
  }

  const sessions = [];
  for (const userId of userIds) {
    sessions.push({
      ...(await signIn(api, values.origin, '/v1/dev/sessions', { userId })),
      userId,
    });
  }
  for (const email of emails) {
    sessions.push(await signIn(api, values.origin, '/v1/auth/password', { email, password }));
  }

  const base = `${api}/v1/organizations/${encodeURIComponent(values.org)}`;
  const projectId = values.project ?? tenant?.projectId;
  const fillWork = Math.floor(nonNegative(values['fill-work'], '--fill-work'));
  const fillMessages = Math.floor(nonNegative(values['fill-messages'], '--fill-messages'));
  const rtSockets = Math.floor(nonNegative(values['realtime-sockets'], '--realtime-sockets'));
  const rtMessages = Math.floor(positive(values['realtime-messages'], '--realtime-messages'));
  const rtGapMs = nonNegative(values['realtime-gap'], '--realtime-gap');
  const rtP95 = positive(values['realtime-p95'], '--realtime-p95');
  const ctx = { base, origin: values.origin, sessions, connections };

  let channelId;
  if (fillMessages > 0 || rtSockets > 0) {
    if (!projectId)
      throw new SetupError('--fill-messages and the probe need --project or --world.');
    channelId = await createChannel(ctx, projectId);
  }
  if (fillWork > 0) {
    if (!projectId) throw new SetupError('--fill-work needs --project or --world.');
    const made = await fill(ctx, fillWork, (i, session) => ({
      method: 'POST',
      path: '/work-items',
      body: {
        projectId,
        title: `Load item ${i} ${['brief', 'review', 'layout', 'copy', 'handoff'][i % 5]}`,
        ...(session.userId ? { ownerUserId: session.userId } : {}),
        // A fifth due within the hour, so My Day has real rows to rank.
        ...(i % 5 === 0 ? { dueAt: new Date(Date.now() + 3_600_000).toISOString() } : {}),
      },
    }));
    console.error(`filled ${made} of ${fillWork} work items`);
  }
  if (fillMessages > 0) {
    const made = await fill(ctx, fillMessages, (i) => ({
      method: 'POST',
      path: `/conversations/${channelId}/messages`,
      body: { body: `Load message ${i} about the layout review` },
    }));
    console.error(`filled ${made} of ${fillMessages} messages`);
  }

  let routes = buildRoutes({
    org: values.org,
    projectId: values.project ?? tenant?.projectId,
    workItemId: values['work-item'] ?? tenant?.workItemId,
    search: values.search ?? firstWord(tenant?.workItemTitle) ?? 'project',
  }).map((r) => (r.kind === 'write' ? { ...r, p95Ms: writeP95 } : r));
  if (values.only) {
    const wanted = new Set(values.only.split(',').map((s) => s.trim()));
    routes = routes.filter((r) => wanted.has(r.name));
    if (routes.length === 0) throw new SetupError(`--only matched no route: ${values.only}`);
  }

  const results = [];
  for (const route of routes) {
    if (warmupS > 0) await hammer(api, values.origin, route, sessions, connections, warmupS);
    const { samples, elapsedMs } = await hammer(
      api,
      values.origin,
      route,
      sessions,
      connections,
      durationS,
    );
    const summary = summarise(samples, elapsedMs);
    const verdict = evaluate(summary, { p95Ms: route.p95Ms, maxErrorRate });
    results.push({ route, summary, verdict });
  }

  if (rtSockets > 0) {
    const probe = await fanOutProbe(ctx, channelId, rtSockets, rtMessages, rtGapMs);
    const route = { ...REALTIME_ROUTE, p95Ms: rtP95 };
    const summary = summarise(probe.samples, probe.elapsedMs);
    results.push({ route, summary, verdict: evaluate(summary, { p95Ms: rtP95, maxErrorRate }) });
  }

  const settings = { api, connections, durationS, users: sessions.length };
  console.log(formatReport(results, settings));
  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ settings, results }, null, 2)}\n`);
  }
  return results.every((r) => r.verdict.pass) ? 0 : 1;
}

/** Start one session and return the headers every later request carries. */
async function signIn(api, origin, path, body) {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.csrfToken !== 'string') {
    const hint = payload.status === 'mfa_required' ? ' (that user has two-step sign-in on)' : '';
    throw new SetupError(`Sign-in through ${path} failed with ${response.status}${hint}.`);
  }
  return {
    cookie: cookieHeaderFrom(response.headers.getSetCookie()),
    csrf: payload.csrfToken,
  };
}

/** Run `connections` loops against one route for `seconds`, round-robin over the sessions. */
async function hammer(api, origin, route, sessions, connections, seconds) {
  const samples = [];
  const started = performance.now();
  const deadline = started + seconds * 1000;
  const loop = async (index) => {
    const session = sessions[index % sessions.length];
    while (performance.now() < deadline) samples.push(await once(api, origin, route, session));
  };
  await Promise.all(Array.from({ length: connections }, (_, i) => loop(i)));
  return { samples, elapsedMs: performance.now() - started };
}

async function once(api, origin, route, session) {
  const headers = { cookie: session.cookie, origin, accept: 'application/json' };
  if (route.method !== 'GET') {
    headers['x-csrf-token'] = session.csrf;
    headers['content-type'] = 'application/json';
  }
  const t0 = performance.now();
  try {
    const response = await fetch(`${api}${route.path}`, {
      method: route.method,
      headers,
      body: route.body ? JSON.stringify(route.body) : undefined,
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    return { ms: performance.now() - t0, ok: response.ok, status: response.status };
  } catch (error) {
    const status = error?.name === 'TimeoutError' ? 'timeout' : 'network';
    return { ms: performance.now() - t0, ok: false, status };
  }
}

/** One authenticated JSON call through a session; returns the parsed body or throws. */
async function call(ctx, session, { method, path, body }) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      origin: ctx.origin,
      accept: 'application/json',
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new SetupError(`${method} ${path} answered ${response.status}`);
  return payload;
}

/** A fresh channel the signed-in users all belong to. */
async function createChannel(ctx, projectId) {
  const [creator, ...others] = ctx.sessions;
  const channel = await call(ctx, creator, {
    method: 'POST',
    path: '/conversations',
    body: { projectId, name: `load-${Date.now().toString(36)}` },
  });
  for (const other of others) {
    if (!other.userId || other.userId === creator.userId) continue;
    await call(ctx, creator, {
      method: 'POST',
      path: `/conversations/${channel.id}/members`,
      body: { userId: other.userId },
    });
  }
  return channel.id;
}

/** Make `total` rows through the API, `connections` at a time. Returns how many succeeded. */
async function fill(ctx, total, request) {
  let next = 0;
  let made = 0;
  const loop = async (index) => {
    const session = ctx.sessions[index % ctx.sessions.length];
    while (next < total) {
      const i = next++;
      try {
        await call(ctx, session, request(i, session));
        made += 1;
      } catch {
        // Counted by the caller's "filled N of M" line; the run still measures what exists.
      }
    }
  };
  await Promise.all(Array.from({ length: ctx.connections }, (_, i) => loop(i)));
  return made;
}

/**
 * NFR-06 fan-out probe. Opens `socketCount` sockets (tickets minted round-robin over the
 * sessions), subscribes each to the channel, then posts `messages` messages `gapMs` apart and
 * records when each socket's `message.created.v1` frame for each one lands.
 */
async function fanOutProbe(ctx, channelId, socketCount, messages, gapMs) {
  const sockets = [];
  const arrivals = [];
  for (let i = 0; i < socketCount; i += 1) {
    const session = ctx.sessions[i % ctx.sessions.length];
    const minted = await call(ctx, session, { method: 'POST', path: '/realtime/tickets' });
    if (typeof minted.socketUrl !== 'string' || !isLocalTarget(minted.socketUrl)) {
      throw new SetupError('The API serves no local socket URL (set REALTIME_PUBLIC_URL).');
    }
    const seen = new Map();
    arrivals.push(seen);
    sockets.push(await subscribe(minted.socketUrl, minted.ticket, channelId, seen));
  }

  const posts = [];
  const started = performance.now();
  for (let i = 0; i < messages; i += 1) {
    const session = ctx.sessions[i % ctx.sessions.length];
    const sentAt = performance.now();
    const message = await call(ctx, session, {
      method: 'POST',
      path: `/conversations/${channelId}/messages`,
      body: { body: `Realtime probe ${i}` },
    });
    posts.push({ messageId: message.id, sentAt });
    if (gapMs > 0) await sleep(gapMs);
  }
  // Give the last message its full window before anything is counted lost.
  const lastSent = posts.at(-1)?.sentAt ?? performance.now();
  const allSeen = () => arrivals.every((seen) => posts.every((p) => seen.has(p.messageId)));
  while (performance.now() < lastSent + REALTIME_FRAME_TIMEOUT_MS && !allSeen()) await sleep(50);
  const elapsedMs = performance.now() - started;
  for (const socket of sockets) socket.close();
  return { samples: fanOutSamples(posts, arrivals), elapsedMs };
}

/** Open one socket, subscribe it, and resolve once the server acknowledges the subscription. */
function subscribe(socketUrl, ticket, conversationId, seen) {
  return new Promise((resolve, reject) => {
    const url = new URL(socketUrl);
    url.searchParams.set('ticket', ticket);
    const socket = new globalThis.WebSocket(url);
    const timer = setTimeout(() => reject(new SetupError('A socket never confirmed.')), 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    });
    socket.addEventListener('message', (event) => {
      const at = performance.now();
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === 'subscribed') {
        clearTimeout(timer);
        resolve(socket);
      } else if (frame.type === 'refused') {
        clearTimeout(timer);
        reject(new SetupError('The socket refused the subscription.'));
      } else if (frame.type === 'event' && !seen.has(frame.objectId)) {
        seen.set(frame.objectId, at);
      }
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new SetupError(`A socket closed during the handshake (${event.code}).`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SetupError extends Error {}

function positive(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new SetupError(`${flag} must be a positive number`);
  return n;
}
function nonNegative(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new SetupError(`${flag} must be zero or more`);
  return n;
}
function firstWord(title) {
  return typeof title === 'string' ? title.split(/\s+/).find((w) => w.length >= 3) : undefined;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const plain = error instanceof SetupError || String(error?.code).startsWith('ERR_PARSE_ARGS');
    console.error(plain ? error.message : error);
    process.exitCode = 2;
  },
);
