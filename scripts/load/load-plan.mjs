/**
 * Pure helpers for `run.mjs`: the performance targets, the route list, the local-host guard,
 * cookie handling and the report maths (percentiles, error rate, pass/miss).
 *
 * Nothing here touches the network, so `load-plan.test.mjs` covers it with plain `node --test`.
 *
 * Targets come from the planning pack:
 *   - NFR-04 / 01-MASTER-PLAN §11 / 13-ENGINEERING-EXECUTION-SPEC §8: common read API p95 < 300 ms.
 *   - 27-TEST-CATALOG PERF-01 Home, PERF-02 Work list, PERF-04 Inbox: p95 < 300 ms.
 *   - 27-TEST-CATALOG PERF-03 Search: p95 < 500 ms.
 * The plan sets no write target; WRITE_P95_MS is this script's own default and says so in the
 * report.
 */

export const READ_P95_MS = 300;
export const SEARCH_P95_MS = 500;
export const WRITE_P95_MS = 500;
/**
 * NFR-06 / PERF-06: typical realtime delivery < 1 s. "Typical" is held to p95 here, the
 * stricter reading, so a probe that passes leaves no room for argument.
 */
export const REALTIME_P95_MS = 1000;
/** How long the fan-out probe waits for one frame on one socket before counting it lost. */
export const REALTIME_FRAME_TIMEOUT_MS = 10_000;

/** The fan-out probe's pseudo-route, so its result rides the same report as the HTTP routes. */
export const REALTIME_ROUTE = {
  name: 'realtime-fan-out',
  ref: 'NFR-06',
  kind: 'realtime',
  method: 'WS',
  path: 'message.created.v1 frame',
  p95Ms: REALTIME_P95_MS,
};

/**
 * Turn the fan-out probe's raw timings into ordinary samples.
 *
 * `posts` = `[{ messageId, sentAt }]` (sentAt = just before the message POST left);
 * `arrivals` = one `Map<messageId, receivedAt>` per subscribed socket. Every (socket, message)
 * pair is one sample: delivered pairs measure `receivedAt - sentAt`; a frame that never came
 * is a failure counted at the timeout, so a lost frame can never improve p95.
 */
export function fanOutSamples(posts, arrivals, timeoutMs = REALTIME_FRAME_TIMEOUT_MS) {
  const samples = [];
  for (const socket of arrivals) {
    for (const { messageId, sentAt } of posts) {
      const receivedAt = socket.get(messageId);
      if (receivedAt === undefined || receivedAt - sentAt > timeoutMs) {
        samples.push({ ms: timeoutMs, ok: false, status: 'lost' });
      } else {
        samples.push({ ms: Math.max(0, receivedAt - sentAt), ok: true, status: 'frame' });
      }
    }
  }
  return samples;
}
/** Share of requests that may fail (non-2xx, timeout, network error) before a route misses. */
export const DEFAULT_MAX_ERROR_RATE = 0.01;

/** A meeting id no row owns: recording it as a recent item is a valid, idempotent upsert. */
export const PLACEHOLDER_MEETING_ID = '00000000-0000-7000-8000-00000000beef';

/**
 * Nearest-rank percentile of an ascending-sorted array. `p` is 0-100.
 * Returns null for an empty array so a route with no samples can never "pass".
 */
export function percentile(sortedAscending, p) {
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error(`percentile out of range: ${p}`);
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (p === 0) return sortedAscending[0];
  const rank = Math.ceil((p / 100) * n);
  return sortedAscending[Math.min(n, Math.max(1, rank)) - 1];
}

/**
 * Summarise one route's samples. Each sample is `{ ms, ok, status }`; `status` is the HTTP
 * status, or `'timeout'` / `'network'` when no response arrived. Latency percentiles cover every
 * sample, failed ones included, so a slow error still counts against p95.
 */
export function summarise(samples, elapsedMs) {
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const statuses = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  const count = samples.length;
  return {
    count,
    errors,
    errorRate: count === 0 ? 0 : errors / count,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: count === 0 ? null : latencies[count - 1],
    rps: elapsedMs > 0 ? (count * 1000) / elapsedMs : 0,
    statuses,
  };
}

/** Compare a summary with a target. Returns `{ pass, misses }`, each miss a plain sentence. */
export function evaluate(summary, target) {
  const misses = [];
  if (summary.count === 0) {
    misses.push('no requests completed');
  } else {
    if (summary.p95 > target.p95Ms) {
      misses.push(`p95 ${round(summary.p95)} ms is over the ${target.p95Ms} ms target`);
    }
    if (summary.errorRate > target.maxErrorRate) {
      misses.push(
        `${summary.errors} of ${summary.count} requests failed (${pct(summary.errorRate)}, ` +
          `limit ${pct(target.maxErrorRate)})`,
      );
    }
  }
  return { pass: misses.length === 0, misses };
}

/**
 * The routes the run hits, in order. `ctx` = `{ org, projectId?, workItemId?, search }`.
 * Every path is tenant-scoped under `/v1/organizations/:orgSlug`.
 */
export function buildRoutes(ctx) {
  const base = `/v1/organizations/${encodeURIComponent(ctx.org)}`;
  const project = ctx.projectId ? `&projectId=${encodeURIComponent(ctx.projectId)}` : '';
  const recent = ctx.workItemId
    ? { objectType: 'work', objectId: ctx.workItemId }
    : { objectType: 'meeting', objectId: PLACEHOLDER_MEETING_ID };
  return [
    {
      name: 'home-my-day',
      ref: 'PERF-01',
      kind: 'read',
      method: 'GET',
      path: `${base}/home/my-day`,
      p95Ms: READ_P95_MS,
    },
    {
      name: 'work-list',
      ref: 'PERF-02',
      kind: 'read',
      method: 'GET',
      path: `${base}/work-items?limit=50${project}`,
      p95Ms: READ_P95_MS,
    },
    {
      name: 'inbox',
      ref: 'PERF-04',
      kind: 'read',
      method: 'GET',
      path: `${base}/inbox`,
      p95Ms: READ_P95_MS,
    },
    {
      name: 'conversations',
      ref: 'NFR-04',
      kind: 'read',
      method: 'GET',
      path: `${base}/conversations`,
      p95Ms: READ_P95_MS,
    },
    {
      name: 'search',
      ref: 'PERF-03',
      kind: 'read',
      method: 'GET',
      path: `${base}/search?q=${encodeURIComponent(ctx.search)}&limit=20`,
      p95Ms: SEARCH_P95_MS,
    },
    {
      name: 'recent-item-write',
      ref: 'script default',
      kind: 'write',
      method: 'PUT',
      path: `${base}/home/recent-items`,
      body: recent,
      p95Ms: WRITE_P95_MS,
    },
  ];
}

/**
 * True only for a local development host: localhost, 127.0.0.0/8, ::1, or a name ending in
 * `.localhost` / `.test`. The runner refuses everything else, so it can never load the live site.
 */
export function isLocalTarget(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url).protocol)) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.localhost') || host.endsWith('.test')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Turn `Set-Cookie` values into one `Cookie` header. Cookies scoped to a narrower path (the
 * refresh cookie) are left out: an ordinary API call would not carry them either.
 */
export function cookieHeaderFrom(setCookies) {
  const pairs = [];
  for (const line of setCookies) {
    const [pair, ...attributes] = line.split(';').map((part) => part.trim());
    if (!pair || !pair.includes('=')) continue;
    const pathAttr = attributes.find((a) => a.toLowerCase().startsWith('path='));
    const path = pathAttr ? pathAttr.slice(5) : '/';
    if (path !== '/') continue;
    pairs.push(pair);
  }
  return pairs.join('; ');
}

/** The plain-text report the runner prints. `results` = `[{ route, summary, verdict }]`. */
export function formatReport(results, settings) {
  const lines = [
    `TManage load test — ${settings.api} — ${settings.connections} connections, ` +
      `${settings.durationS} s per route, ${settings.users} signed-in user(s)`,
    '',
    pad('route', 20) +
      pad('target', 16) +
      pad('reqs', 8) +
      pad('rps', 8) +
      pad('p50', 8) +
      pad('p95', 8) +
      pad('p99', 8) +
      pad('errors', 10) +
      'result',
  ];
  for (const { route, summary, verdict } of results) {
    lines.push(
      pad(route.name, 20) +
        pad(`p95<${route.p95Ms} ${route.ref === 'script default' ? '*' : route.ref}`, 16) +
        pad(String(summary.count), 8) +
        pad(round(summary.rps), 8) +
        pad(ms(summary.p50), 8) +
        pad(ms(summary.p95), 8) +
        pad(ms(summary.p99), 8) +
        pad(`${summary.errors} ${pct(summary.errorRate)}`, 10) +
        (verdict.pass ? 'PASS' : 'MISS'),
    );
    for (const miss of verdict.misses) lines.push(`    - ${miss}`);
  }
  lines.push('');
  if (results.some((r) => r.route.ref === 'script default')) {
    lines.push('* the plan sets no write target; this one is the script default (--write-p95).');
  }
  const missed = results.filter((r) => !r.verdict.pass).length;
  lines.push(
    missed === 0 ? 'All routes met their targets.' : `${missed} route(s) missed their targets.`,
  );
  return lines.join('\n');
}

function round(n) {
  return n === null || n === undefined ? '-' : String(Math.round(n));
}
function ms(n) {
  return n === null ? '-' : `${Math.round(n)}`;
}
function pct(rate) {
  return `${(rate * 100).toFixed(rate === 0 ? 0 : 1)}%`;
}
function pad(s, width) {
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}
