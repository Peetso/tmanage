/**
 * Local load test against the planning pack's performance targets. See README.md.
 *
 *   node scripts/load/run.mjs --world world.json [--duration 20] [--connections 10]
 *
 * Signs in seeded test users, hits the main read routes and one write route for a fixed time
 * each, prints p50/p95/p99 and errors per route against its target, and exits 1 on any miss
 * (2 on a setup error). It refuses any API that is not a local development host.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import {
  DEFAULT_MAX_ERROR_RATE,
  WRITE_P95_MS,
  buildRoutes,
  cookieHeaderFrom,
  evaluate,
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
  for (const userId of userIds)
    sessions.push(await signIn(api, values.origin, '/v1/dev/sessions', { userId }));
  for (const email of emails) {
    sessions.push(await signIn(api, values.origin, '/v1/auth/password', { email, password }));
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
