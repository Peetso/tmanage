#!/usr/bin/env node
// Uptime check (C10) — poll TManage's health endpoints from somewhere else and mail when they fail.
//
//   UPTIME_URL=https://tmanage.example.com node scripts/ops/uptime-check.mjs          # one pass (= --once)
//   UPTIME_URL=https://tmanage.example.com node scripts/ops/uptime-check.mjs --loop   # every 5 min
//
// Run it from a machine that is NOT the server (a home PC's Task Scheduler, a cron box): a check
// running on the host it watches goes quiet exactly when the host does. A free external monitor
// (UptimeRobot, Better Stack free tier, …) pointed at `/healthz/deep` does the same job without
// this script; the script exists so nothing paid or third-party is required.
//
// It checks `GET /healthz` (the process answers) and `GET /healthz/deep` (database, migrations,
// worker heartbeat — 503 when one fails). A failure mails every address in ALERT_EMAILS through
// the SMTP settings the app uses (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USERNAME, SMTP_PASSWORD,
// EMAIL_FROM_ADDRESS), at most once per 15 minutes per kind — the throttle is kept in a small state
// file (UPTIME_STATE_FILE, default in the OS temp folder) so cron-driven passes share it. When a
// failing check passes again, one "recovered" mail is sent. Without ALERT_EMAILS or SMTP_HOST the
// alert is printed instead. One pass exits 1 while anything fails, so the scheduler sees it too.
//
// 56-30. With UPTIME_ORIGIN_ADDRESS (`<origin ip>:443`) it also handshakes with the origin directly,
// bypassing Cloudflare, with SNI UPTIME_ORIGIN_SERVERNAME (default: the host of UPTIME_URL), and
// reads the leaf certificate: `origin_tls_expiring` at 14 days or fewer, `origin_tls_unreadable`
// when the handshake fails. Unset = the check is skipped (and printed). The app's own reading,
// `/healthz/deep` `checks.origin_tls`, is printed beside it. Runbook: docs/runbooks/origin-tls-526.md.
//
// No secret lives here: every credential is read from the environment.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { connect } from 'node:tls';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALERT_WINDOW_MS = 15 * 60 * 1_000;
const TIMEOUT_MS = 15_000;
/** 56-30. At or below this many days the origin certificate is an alert. */
export const ORIGIN_TLS_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Parse ALERT_EMAILS the way the app does: lower-cased, de-duplicated, junk dropped. */
export function parseAlertEmails(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) && email.length <= 254) seen.add(email);
  }
  return [...seen];
}

/**
 * Turn the two probe results into failing kinds.
 * @param {{ healthz: { status: number } | { error: string }, deep: { status: number, body?: unknown } | { error: string } }} results
 * @returns {{ kind: string, detail: string }[]}
 */
export function failuresFrom(results) {
  const out = [];
  const { healthz, deep } = results;
  if ('error' in healthz)
    out.push({ kind: 'uptime_down:healthz', detail: `no answer (${healthz.error})` });
  else if (healthz.status !== 200)
    out.push({ kind: 'uptime_down:healthz', detail: `HTTP ${healthz.status}` });
  if ('error' in deep) {
    out.push({ kind: 'uptime_fail:deep', detail: `no answer (${deep.error})` });
  } else if (deep.status !== 200) {
    const checks =
      deep.body &&
      typeof deep.body === 'object' &&
      deep.body.checks &&
      typeof deep.body.checks === 'object'
        ? Object.entries(deep.body.checks)
            .filter(([, state]) => state === 'fail')
            .map(([name]) => name)
            .join(', ')
        : '';
    out.push({
      kind: 'uptime_fail:deep',
      detail: `HTTP ${deep.status}${checks ? ` — failing: ${checks}` : ''}`,
    });
  }
  return out;
}

/** `1.2.3.4:443` / `host` / `[::1]:8443` → `{ host, port }`, or null. */
export function parseOriginAddress(address) {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+))(?::(\d{1,5}))?$/u.exec(String(address).trim());
  const host = match?.[1] ?? match?.[2];
  if (host === undefined) return null;
  const port = match?.[3] === undefined ? 443 : Number(match[3]);
  return port >= 1 && port <= 65_535 ? { host, port } : null;
}

/**
 * 56-30. One TLS handshake; reads the leaf certificate only (`rejectUnauthorized: false`: an
 * Origin CA certificate is trusted by Cloudflare alone, and nothing is sent).
 * @returns {Promise<{ issuer: string, notAfter: string, daysLeft: number } | { error: string }>}
 */
export function readOriginTls(address, servername, now = Date.now(), timeoutMs = TIMEOUT_MS) {
  const target = parseOriginAddress(address);
  if (target === null) return Promise.resolve({ error: 'bad_address' });
  return new Promise((done) => {
    let settled = false;
    const socket = connect({
      host: target.host,
      port: target.port,
      rejectUnauthorized: false,
      ...(servername ? { servername } : {}),
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => finish({ error: 'TimeoutError' }));
    socket.once('error', (error) => finish({ error: error?.code ?? 'error' }));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const notAfter = new Date(cert?.valid_to ?? '');
      if (Number.isNaN(notAfter.getTime())) return finish({ error: 'no_certificate' });
      const issuer = [cert.issuer?.CN, cert.issuer?.O].filter(Boolean).join(', ');
      finish({
        issuer,
        notAfter: notAfter.toISOString(),
        daysLeft: Math.floor((notAfter.getTime() - now) / DAY_MS),
      });
    });
  });
}

/** 56-30. The origin reading as failing kinds; `undefined` (not configured) is none. */
export function originTlsFailures(reading) {
  if (reading === undefined) return [];
  if ('error' in reading)
    return [{ kind: 'origin_tls_unreadable', detail: `handshake failed (${reading.error})` }];
  if (reading.daysLeft <= ORIGIN_TLS_WARN_DAYS)
    return [
      {
        kind: 'origin_tls_expiring',
        detail: `daysLeft=${String(reading.daysLeft)} (notAfter ${reading.notAfter}, issuer ${reading.issuer})`,
      },
    ];
  return [];
}

/** 56-30. `/healthz/deep`'s own `checks.origin_tls`, as one printable line (or null). */
export function deepOriginTlsLine(body) {
  const check = body && typeof body === 'object' ? body.checks?.origin_tls : undefined;
  if (!check || typeof check !== 'object' || typeof check.state !== 'string') return null;
  return check.state === 'not_configured'
    ? 'deep origin_tls not_configured'
    : `deep origin_tls ${check.state} daysLeft=${String(check.daysLeft)}`;
}

/**
 * Decide which mails to send this pass and the next state. Pure.
 * @param {Record<string, { lastSentAt: number, held: number }>} state
 * @param {{ kind: string, detail: string }[]} failures
 * @param {number} now
 */
export function decide(state, failures, now, windowMs = ALERT_WINDOW_MS) {
  const next = {};
  const send = [];
  const failing = new Set(failures.map((f) => f.kind));
  for (const failure of failures) {
    const prior = state[failure.kind];
    if (prior && now - prior.lastSentAt < windowMs) {
      next[failure.kind] = { lastSentAt: prior.lastSentAt, held: prior.held + 1 };
    } else {
      send.push({ ...failure, held: prior?.held ?? 0, recovered: false });
      next[failure.kind] = { lastSentAt: now, held: 0 };
    }
  }
  for (const kind of Object.keys(state)) {
    if (!failing.has(kind)) send.push({ kind, detail: 'passing again', held: 0, recovered: true });
  }
  return { send, next };
}

/** The plain-text mail for one decision. */
export function renderMail(item, baseUrl, at) {
  const subject = item.recovered
    ? `[TManage alert] Recovered: ${item.kind}`
    : `[TManage alert] TManage is not healthy: ${item.kind}`;
  const lines = [
    item.recovered ? 'The check is passing again.' : 'An uptime check failed.',
    '',
    `Kind: ${item.kind}`,
    `Site: ${baseUrl}`,
    `Time (UTC): ${at.toISOString()}`,
    `Detail: ${item.detail}`,
  ];
  if (item.held > 0)
    lines.push(`Held back since the last alert of this kind: ${String(item.held)}`);
  lines.push('', 'You get at most one alert of each kind every 15 minutes.');
  return { subject, text: lines.join('\n') };
}

async function probe(url) {
  try {
    const response = await fetch(url, {
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'cache-control': 'no-cache' },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** nodemailer, borrowed from @tmanage/mail's own dependencies — nothing new to install. */
function loadNodemailer() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const from of [join(root, 'packages/mail/package.json'), join(root, 'package.json')]) {
    try {
      return createRequire(from)('nodemailer');
    } catch {
      // try the next location
    }
  }
  return null;
}

async function deliver(env, mails) {
  const recipients = parseAlertEmails(env.ALERT_EMAILS);
  const nodemailer = recipients.length > 0 && env.SMTP_HOST ? loadNodemailer() : null;
  if (!nodemailer) {
    for (const mail of mails) process.stderr.write(`${mail.subject}\n${mail.text}\n\n`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USERNAME
      ? { auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD ?? '' } }
      : {}),
  });
  const from = env.EMAIL_FROM_ADDRESS ?? env.SMTP_USERNAME;
  for (const mail of mails) {
    for (const to of recipients) {
      try {
        await transport.sendMail({ from, to, subject: mail.subject, text: mail.text });
      } catch (error) {
        process.stderr.write(
          `[uptime] could not mail ${to} (${error instanceof Error ? error.name : 'unknown'})\n`,
        );
      }
    }
  }
}

/** One pass: probe, decide, mail, save state. Resolves to the number of failing checks. */
export async function runOnce(env = process.env, now = Date.now()) {
  const base = (env.UPTIME_URL ?? '').replace(/\/+$/u, '');
  if (!/^https?:\/\//u.test(base))
    throw new Error('Set UPTIME_URL to the site address, e.g. https://tmanage.example.com');
  const statePath = env.UPTIME_STATE_FILE ?? join(tmpdir(), 'tmanage-uptime-state.json');
  const [healthz, deep] = await Promise.all([
    probe(`${base}/healthz`),
    probe(`${base}/healthz/deep`),
  ]);
  const failures = failuresFrom({ healthz, deep });
  const originAddress = (env.UPTIME_ORIGIN_ADDRESS ?? '').trim();
  if (originAddress === '') {
    process.stdout.write('[uptime] origin_tls skipped (UPTIME_ORIGIN_ADDRESS unset)\n');
  } else {
    const servername = env.UPTIME_ORIGIN_SERVERNAME || new URL(base).hostname;
    const reading = await readOriginTls(originAddress, servername, now);
    process.stdout.write(
      'error' in reading
        ? `[uptime] origin_tls unreadable (${reading.error})\n`
        : `[uptime] origin_tls daysLeft=${String(reading.daysLeft)} notAfter=${reading.notAfter}\n`,
    );
    failures.push(...originTlsFailures(reading));
  }
  const deepLine = 'error' in deep ? null : deepOriginTlsLine(deep.body);
  if (deepLine !== null) process.stdout.write(`[uptime] ${deepLine}\n`);
  const { send, next } = decide(readState(statePath), failures, now);
  if (send.length > 0)
    await deliver(
      env,
      send.map((item) => renderMail(item, base, new Date(now))),
    );
  try {
    writeFileSync(statePath, JSON.stringify(next));
  } catch {
    process.stderr.write(
      '[uptime] could not save the throttle state; the next pass may mail again\n',
    );
  }
  process.stdout.write(
    failures.length === 0
      ? `[uptime] ok ${base}\n`
      : `[uptime] FAIL ${failures.map((f) => f.kind).join(', ')}\n`,
  );
  return failures.length;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const loop = process.argv.includes('--loop');
  const intervalMs = Math.max(60, Number(process.env.UPTIME_INTERVAL_SECONDS ?? 300)) * 1_000;
  try {
    if (!loop) {
      process.exitCode = (await runOnce()) > 0 ? 1 : 0;
    } else {
      for (;;) {
        await runOnce().catch((error) => process.stderr.write(`[uptime] ${error.message}\n`));
        await new Promise((done) => setTimeout(done, intervalMs));
      }
    }
  } catch (error) {
    process.stderr.write(`[uptime] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
