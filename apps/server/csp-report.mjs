// `POST /csp-report` — where browsers send Content-Security-Policy and Trusted Types violation
// reports (56-01). Answered by the single-process server itself, ahead of the API hand-off, so it
// is not an API route: no route census or never-list entry, no database, no session.
//
// What it does with a report is log ONE redacted line, the evidence the report-only soak is read
// from (docs/runbooks/csp-enforcement.md):
//
//   csp-report {"documentUri":"/northstar-studio/home","violatedDirective":"script-src-elem",
//               "blockedUri":"https://evil.example"}
//
// Only the page's PATH (no query string, no fragment), the directive's name, and the blocked
// resource's ORIGIN (or a keyword: inline, eval, data, blob, ...). No cookie is read, so there is
// no user id to log, and nothing the browser sent is echoed back.
//
// Limits (B18, sized to real traffic): 64 KB of body (413) — one `report-uri` report carries the
// whole original policy and runs 1–3 KB, a Reporting API batch holds many — and a per-address
// token bucket of 600 reports that refills at 300 a minute (429), so a tab burst from several
// tabs behind one office address is kept. Anything else 204; a malformed report is dropped
// silently rather than explained to whoever sent it. A line already logged in the last minute is
// not logged again: one broken page in many tabs is one line, not hundreds.

import { BlockList, isIP } from 'node:net';

export const CSP_REPORT_PATH = '/csp-report';
export const MAX_BODY_BYTES = 64 * 1024;
/** Burst a client may send at once, and the steady rate it refills at. */
export const MAX_BURST = 600;
export const MAX_PER_MINUTE = 300;
/** Reports read from one Reporting API batch. */
const MAX_BATCH = 100;
const WINDOW_MS = 60_000;
/** Above this many tracked addresses, expired windows are swept before a new one is added. */
const SWEEP_AT = 10_000;

/** Whether a request URL is the report receiver (exact path; a query string is ignored). */
export function isCspReportPath(url) {
  return (url ?? '').split('?')[0] === CSP_REPORT_PATH;
}

function plainAddress(address) {
  const value = String(address ?? '').trim();
  return value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4
    ? value.slice(7)
    : value;
}

/**
 * `TRUSTED_PROXY_ADDRESSES` — the same comma-separated addresses and CIDR ranges the API is given
 * (`.env.example`, D09) — as a matcher. Blank trusts nobody. `@tmanage/config` refuses a malformed
 * value at boot, so an entry that still does not parse here is skipped rather than trusted.
 */
export function trustedProxyMatcher(value) {
  const list = new BlockList();
  let any = false;
  for (const entry of String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address, bits] = entry.split('/');
    const family = isIP(address);
    if (family === 0) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    try {
      if (bits === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(bits), type);
      any = true;
    } catch {
      // skipped, see above
    }
  }
  return (address) => {
    const plain = plainAddress(address);
    const family = isIP(plain);
    return any && family !== 0 && list.check(plain, family === 6 ? 'ipv6' : 'ipv4');
  };
}

/**
 * The client's address, by the API's rule: the socket peer, unless that peer is a trusted proxy —
 * then the RIGHT-MOST X-Forwarded-For entry no trusted peer wrote (an appending proxy is the safe
 * shape; see `.env.example`).
 */
export function clientAddress(req, isTrusted) {
  const peer = plainAddress(req.socket?.remoteAddress);
  if (!isTrusted(peer)) return peer;
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => plainAddress(part))
    .filter(Boolean);
  for (let i = forwarded.length - 1; i >= 0; i -= 1) {
    if (!isTrusted(forwarded[i])) return forwarded[i];
  }
  return forwarded[0] ?? peer;
}

/**
 * A token bucket per address, in memory (one process; a restart forgets, by design): `burst`
 * reports at once, refilled at `perMinute`. `cost` is the number of reports in the request.
 */
export function createReportLimiter({
  burst = MAX_BURST,
  perMinute = MAX_PER_MINUTE,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  const refill = (bucket, at) =>
    Math.min(burst, bucket.tokens + ((at - bucket.at) * perMinute) / WINDOW_MS);
  return (key, cost = 1) => {
    const at = now();
    if (buckets.size >= SWEEP_AT) {
      for (const [k, b] of buckets) if (refill(b, at) >= burst) buckets.delete(k);
    }
    const bucket = buckets.get(key) ?? { tokens: burst, at };
    bucket.tokens = refill(bucket, at);
    bucket.at = at;
    buckets.set(key, bucket);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  };
}

/** `true` the first time a line is seen in a minute; bounded, so a flood cannot grow it. */
export function createLineDeduper({ now = Date.now } = {}) {
  const seen = new Map();
  return (line) => {
    const at = now();
    if (seen.size >= SWEEP_AT) {
      for (const [k, t] of seen) if (at - t >= WINDOW_MS) seen.delete(k);
      if (seen.size >= SWEEP_AT) seen.clear();
    }
    const last = seen.get(line);
    if (last !== undefined && at - last < WINDOW_MS) return false;
    seen.set(line, at);
    return true;
  };
}

const KEYWORDS = new Set([
  'inline',
  'eval',
  'self',
  'data',
  'blob',
  'wasm-eval',
  'trusted-types-sink',
  'trusted-types-policy',
]);

function pathOnly(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return new URL(value).pathname.slice(0, 200);
  } catch {
    return undefined;
  }
}

function originOnly(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const word = value.trim().toLowerCase();
  if (KEYWORDS.has(word)) return word;
  try {
    const url = new URL(value);
    return url.origin !== 'null' ? url.origin : url.protocol.replace(/:$/, '');
  } catch {
    return undefined;
  }
}

function directiveName(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^[a-z-]{1,40}/.exec(value.trim().toLowerCase());
  return match?.[0];
}

/**
 * The redacted summaries of every report in a body (`[]` when it holds none). Reads both shapes:
 * `report-uri`'s `{"csp-report": {...}}` and the Reporting API's batch `[{type, body}, ...]`.
 */
export function summarizeReports(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const reports = Array.isArray(parsed)
    ? parsed.slice(0, MAX_BATCH).map((entry) => entry?.body)
    : [parsed?.['csp-report']];
  return reports.map(summarizeOne).filter((summary) => summary !== undefined);
}

/** The first report's summary, or `undefined` (kept for callers of the single-report shape). */
export function summarizeReport(text) {
  return summarizeReports(text)[0];
}

function summarizeOne(report) {
  if (report === null || typeof report !== 'object') return undefined;
  const summary = {
    documentUri: pathOnly(report['document-uri'] ?? report.documentURL),
    violatedDirective: directiveName(
      report['effective-directive'] ??
        report.effectiveDirective ??
        report['violated-directive'] ??
        report.violatedDirective,
    ),
    blockedUri: originOnly(report['blocked-uri'] ?? report.blockedURL),
  };
  return summary.violatedDirective === undefined ? undefined : summary;
}

function answer(res, status, extra = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...extra });
  res.end();
}

/** The request handler. `log` receives one line per accepted report. */
export function createCspReportHandler({
  trustedProxies,
  log,
  limiter = createReportLimiter(),
  firstSeen = createLineDeduper(),
} = {}) {
  const isTrusted = trustedProxyMatcher(trustedProxies);
  return (req, res) => {
    if (req.method !== 'POST') {
      answer(res, 405, { allow: 'POST' });
      req.resume();
      return;
    }
    const client = clientAddress(req, isTrusted);
    // One token to read the body at all; a batch pays for the rest of its reports once parsed.
    if (!limiter(client)) {
      answer(res, 429, { 'retry-after': '60', connection: 'close' });
      req.resume();
      return;
    }
    const tooLarge = () => {
      res.once('finish', () => req.destroy());
      answer(res, 413, { connection: 'close' });
    };
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      tooLarge();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const summaries = summarizeReports(Buffer.concat(chunks).toString('utf8'));
      if (summaries.length > 1 && !limiter(client, summaries.length - 1)) {
        answer(res, 429, { 'retry-after': '60' });
        return;
      }
      for (const summary of summaries) {
        const line = `csp-report ${JSON.stringify(summary)}`;
        if (firstSeen(line)) log(line);
      }
      answer(res, 204);
    });
    req.on('error', () => {
      done = true;
    });
  };
}
