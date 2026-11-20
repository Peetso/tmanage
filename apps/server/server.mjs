// The single-process TManage server — the 50-BOOTSTRAP §3 fallback, shaped for Hostinger's
// panel-managed Node hosting: one Node app per (sub)domain, behind the platform's reverse proxy,
// started as `node server.mjs` with `PORT` and the environment supplied by hPanel.
//
// It serves BOTH halves of the application on the one `PORT` Hostinger exposes, through a thin
// dispatcher:
//
//   * every request whose path begins `/v1` is handed to the NestJS/Fastify API, dispatched
//     in-process through Fastify's own `routing(req, res)` (the entry its `serverFactory` uses),
//     so the API receives the request DIRECTLY — there is exactly one proxy hop in front of it,
//     Hostinger's, which is what `TRUSTED_PROXY_ADDRESSES` names;
//   * `/healthz` is answered here, as a dependency-light liveness probe;
//   * `POST /csp-report` (browser CSP violation reports, 56-01) is answered here too, before the
//     API hand-off — rate-limited, size-capped, one redacted log line (csp-report.mjs);
//   * everything else is reverse-proxied to a Next.js production server (`next start`) this
//     process launches as a child, over a private Unix socket file (web-transport.mjs: Hostinger
//     refuses loopback TCP between the app's own processes).
//
// The public port is bound FIRST, before migrations, Nest or the web child: LiteSpeed restarts an
// app that has not called listen() within ~3 s. Until everything is ready every request — /healthz
// included — answers 503 {"status":"starting"} with Retry-After.
//
// Why a child `next start` rather than Next's programmatic request handler: Next 16 builds with
// Turbopack, and a Turbopack production build served through the programmatic custom server does
// not wire preview-mode props into SSR (pages 500). `next start` is the server that build is made
// for. Running it privately and proxying to it keeps the whole app on one public port and one
// startup file, while the API still gets the raw request.
//
// Because the browser reaches the page and `/v1` through the ONE origin Hostinger terminates TLS
// for, this is the same-origin topology `apps/web/src/lib/public-config.ts` documents (review
// finding D03): the API's cookies are set on this host, its readable CSRF cookie is readable by
// this page, and its path-scoped refresh cookie is sent to the path it was scoped to. The
// security model is unchanged; the two applications run as one app rather than two.
//
// Production or nothing: must be the first import, so NODE_ENV is settled before any module that
// might read it is evaluated (pre-launch security review 2026-10-17, HIGH).
import './production-env.mjs';
// reflect-metadata must be evaluated before any Nest decorator is read — once, here.
import 'reflect-metadata';

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from '@tmanage/config';
import { createPartAdmission } from '@tmanage/storage';
import { NestFactory } from '@nestjs/core';

import {
  composeAppModule,
  corsOptions,
  createFastifyAdapter,
  createFixedWindowLimiter,
  createGroupedAlertNotifier,
  describeReconciliation,
  describeSweep,
  migrateOnStart,
  MigrationError,
  parseAlertEmails,
  serializeForLog,
  UPLOAD_SESSION_SWEEPER,
  USAGE_RECONCILER,
} from '@tmanage/api/hostinger';

import { DOWNLOADS_DIR, isHttpsRequest, webSecurityHeaders } from './boot-guards.mjs';
import { webCacheHeaders } from './cache-headers.mjs';
import { createCspReportHandler, isCspReportPath } from './csp-report.mjs';
import { createSecurityTxtHandler, isSecurityTxtPath } from './security-txt.mjs';
import { createPageLimiter } from './page-limit.mjs';
import { resolveDatabaseEnv } from './database-env.mjs';
import {
  applyRealtimePublicUrl,
  createUpgradeHandler,
  realtimeInProcessEnabled,
  leaderRelayHandlers,
  startRealtimeTail,
} from './realtime-inprocess.mjs';
import {
  beat,
  createHeartbeatWatchdog,
  reportJobOutcome,
  WATCHDOG_INTERVAL_MS,
} from './job-alerts.mjs';
import { installProcessAlerts } from './process-alerts.mjs';
import { createMigrationGate } from './migration-shutdown.mjs';
import { createLeadership, leaderGatedLock } from './leadership.mjs';
import {
  createPublicServer,
  WEB_UPSTREAM_AGENT,
  webChildKeepAliveArgs,
} from './server-timeouts.mjs';
import {
  apiReconcileJobs,
  apiSweepJobs,
  createSweepScheduler,
  reconcileIntervalMs,
  sweepIntervalMs,
  startWebhookDeliveries,
  startActivityProjector,
  startBudgetBurn,
  startRetainerRoll,
  startScheduledJobs,
  startSignalsSweep,
  sweepsEnabled,
  workerSweepJobs,
} from './scheduled-sweeps.mjs';
import { WEB_HEALTHY_MS, webRestartDelayMs } from './web-restart.mjs';
import { createPlatformGate, isPlatformPath } from './platform-gate.mjs';
import {
  bindProxyLifetimes,
  becomeReady,
  cleanupWebTransport,
  createPublicHandler,
  describeWebTransport,
  forwardableHeaders,
  prepareWebTransport,
  resolveWebTransport,
  webChildEnv,
  webChildHost,
  webChildPublicConfig,
  webConnectTarget,
  webTarget,
} from './web-transport.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.env['TMANAGE_WEB_DIR'] ?? resolve(ROOT, 'web');
const MIGRATIONS_DIR = process.env['TMANAGE_MIGRATIONS_DIR'] ?? resolve(ROOT, 'migrations');

function log(message) {
  process.stderr.write(`[server] ${message}\n`);
}

/**
 * R3 (2026-11-21, measurement only): one line per boot stage with this process's pid and the ms
 * since the process started (`process.uptime()`, so static-import time is included). Distinct
 * pids in these lines count the copies Hostinger started; the gaps say where the cold start goes.
 */
function bootMark(stage) {
  log(`boot: ${stage} +${Math.round(process.uptime() * 1000)}ms (pid ${process.pid})`);
}

/**
 * Apply the schema on start — guarded, idempotent, locked.
 *
 * The migrator holds a MySQL advisory lock for its whole run, refuses to touch a partially
 * applied schema, and is a no-op when nothing is pending (the second start proves it). A failure
 * stops boot: a process serving a half-migrated schema is the outage the migrator prevents.
 *
 * Runs through `gate` (migration-shutdown.mjs): a SIGTERM while it runs lets the file in progress
 * finish and starts no further file, and the shutdown waits for that (bounded) before it exits.
 */
async function runMigrations(env, gate) {
  const report = await gate.run((shouldStop) =>
    migrateOnStart(env.DATABASE_MIGRATION_URL, {
      directory: MIGRATIONS_DIR,
      appliedBy: 'hostinger-bundle',
      log,
      shouldStop,
    }),
  );
  if (report.resumed !== null) {
    log(`migrations: resumed version ${report.resumed} left 'running' by a killed process`);
  }
  log(
    report.stopped
      ? `migrations: stopped for shutdown after ${report.applied.length} file(s)`
      : report.applied.length === 0
        ? `migrations: nothing to apply (${report.alreadyApplied.length} already applied)`
        : `migrations: applied ${report.applied.length} in ${report.durationMs}ms`,
  );
}

/** Build the composed API, initialised but NOT bound to a socket of its own. */
async function createApi(env) {
  const app = await NestFactory.create(
    composeAppModule(env),
    createFastifyAdapter({
      trustProxy: env.TRUSTED_PROXY_ADDRESSES,
      uploadPartSizeBytes: env.UPLOAD_PART_SIZE_BYTES,
      // Pre-body part admission for the signed part transport, which both the filesystem
      // and the local (production) drivers use; on s3 there is none and no body is read.
      admitPart:
        (env.STORAGE_DRIVER === 'filesystem' || env.STORAGE_DRIVER === 'local') &&
        env.STORAGE_LOCAL_SIGNING_SECRET
          ? createPartAdmission(env.STORAGE_LOCAL_SIGNING_SECRET)
          : undefined,
      admitClient: createFixedWindowLimiter({
        windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1_000,
        max: env.RATE_LIMIT_MAX_REQUESTS,
      }),
    }),
    { bufferLogs: false },
  );
  app.enableCors(corsOptions(env.CORS_ALLOWED_ORIGINS));
  // `init()` rather than `listen()`: wires the whole application and the Fastify adapter without
  // binding a port. `ready()` then makes the Fastify instance accept `routing(req, res)`.
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();
  return { app, fastify };
}

function waitForWeb(transport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const attempt = () => {
      const socket = createConnection(webConnectTarget(transport));
      socket.once('connect', () => {
        socket.destroy();
        done();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          fail(new Error(`web server never opened ${describeWebTransport(transport)}`));
        } else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** The web child once spawned, so a failed boot or any exit stops it too. */
let webChildRef;
/** Set once we are tearing down on purpose, so the child we kill is not respawned. */
let webSupervisionStopped = false;
/** Consecutive-crash count; cleared once a child has stayed up past WEB_HEALTHY_MS. */
let webRestartCount = 0;

/** Stop supervising the web child — a deliberate kill must not look like a crash. */
function stopWebSupervision() {
  webSupervisionStopped = true;
}

/** Spawn one `next start` child on the private transport (no supervision of its own). */
function spawnWebChild(transport, nominalPort) {
  const nextBin = require.resolve('next/dist/bin/next');
  // R2: the parent watchdog is preloaded on every transport, so the child ends with this process
  // even when this process is SIGKILLed (parent-watchdog.mjs).
  const preload = [
    '--import',
    pathToFileURL(resolve(ROOT, 'parent-watchdog.mjs')).href,
    ...(transport.kind === 'tcp'
      ? []
      : ['--import', pathToFileURL(resolve(ROOT, 'web-socket-preload.mjs')).href]),
  ];
  return spawn(
    process.execPath,
    [
      ...preload,
      nextBin,
      'start',
      '-p',
      String(nominalPort),
      '-H',
      webChildHost(transport),
      // ST-3: the child keeps idle connections longer than this process's agent (server-timeouts).
      ...webChildKeepAliveArgs(),
    ],
    {
      cwd: WEB_DIR,
      env: {
        // PORT is overridden so the child never binds the public port this process owns,
        // HOSTNAME keeps it off the public interface, and LiteSpeed's LSNODE_* variables are
        // dropped (web-transport.mjs).
        ...webChildEnv(process.env, transport, nominalPort),
        // next.config re-runs its public-config validation when `next start` loads it.
        ...webChildPublicConfig(process.env),
        // R2: the pid the child's watchdog follows (parent-watchdog.mjs).
        TMANAGE_PARENT_PID: String(process.pid),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
}

/**
 * Launch `next start` under supervision and resolve once it accepts connections on the private
 * transport.
 *
 * On a socket (or named-pipe) transport the child is preloaded with web-socket-preload.mjs, which
 * redirects its listen() on the nominal port to the socket file; `-p` only names that port.
 *
 * OPS-01: an unexpected exit no longer takes the whole app down. The public port and the
 * in-process API keep serving while the child is respawned after a capped exponential backoff
 * (web-restart.mjs); a child that stays up past WEB_HEALTHY_MS clears the backoff. A deliberate
 * shutdown calls stopWebSupervision() before killing the child, so that kill is not mistaken for a
 * crash and never triggers a respawn.
 */
async function startWeb(transport, nominalPort) {
  const supervise = (child) => {
    // Clear the backoff once THIS child has stayed up long enough. Guarded by identity rather
    // than a cancelled timer: if the child has already exited and been replaced, webChildRef
    // points at a newer child and this stale timer is a no-op.
    const healthyTimer = setTimeout(() => {
      if (webChildRef === child && !webSupervisionStopped) webRestartCount = 0;
    }, WEB_HEALTHY_MS);
    healthyTimer.unref();
    child.once('exit', (code, signal) => {
      if (webSupervisionStopped) return;
      const delay = webRestartDelayMs(webRestartCount);
      webRestartCount += 1;
      log(
        `next start exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) — ` +
          `restarting web child in ${delay}ms (attempt ${webRestartCount})`,
      );
      const timer = setTimeout(() => {
        if (webSupervisionStopped) return;
        webChildRef = spawnWebChild(transport, nominalPort);
        supervise(webChildRef);
      }, delay);
      timer.unref();
    });
  };

  webChildRef = spawnWebChild(transport, nominalPort);
  supervise(webChildRef);
  await waitForWeb(transport, 180_000);
  return webChildRef;
}

/** Reverse-proxy one request to the private web server, streaming both ways. */
function proxyToWeb(req, res, transport) {
  const upstream = httpRequest(
    {
      ...webTarget(transport),
      // ST-3: a pooled agent whose idle sockets close before the child's (server-timeouts.mjs).
      agent: WEB_UPSTREAM_AGENT,
      method: req.method,
      path: req.url,
      // NV06: hop-by-hop headers (Connection, Upgrade, ...) stay on this hop.
      headers: forwardableHeaders(req.headers),
    },
    (up) => {
      // HSTS on every HTTPS response, and a report-only CSP on HTML (security review §3). Pages
      // never keep Next's one-year s-maxage at the CDN, and vary by the saved-locale cookie
      // (cache-headers.mjs, live M1/N1, wave 6 E3).
      res.writeHead(up.statusCode ?? 502, {
        ...up.headers,
        ...webSecurityHeaders(
          up.headers,
          isHttpsRequest(req.headers, req.socket.encrypted === true),
        ),
        ...webCacheHeaders(req.url, up.headers, req.headers),
      });
      up.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    log(`web proxy error: ${serializeForLog(error)}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  // NV06: the upstream dies with the client (close, error or idle), never outlives it.
  bindProxyLifetimes(req, res, upstream);
  req.pipe(upstream);
}

/**
 * The in-process outbox relay — on only when `WORKER_INPROCESS=1`.
 *
 * Runs the worker's own `relay:once` batch on a timer inside this process, so a plan that cannot
 * keep a third Node process alive still delivers mail and notifications. Limitation (documented):
 * when Hostinger sleeps the app, the timer sleeps too, so delivery resumes on the next request.
 *
 * DC-3 / RT-3: started only on the copy that holds the leader lease, and every batch asks
 * `mayRun()` (the lease) first, so a copy that lost the lease starts no new batch.
 */
async function startInProcessWorker(
  env,
  realtimeHub,
  shareMail = () => undefined,
  mayRun = () => true,
) {
  const worker = await import('@tmanage/worker');
  const {
    createWorkerDatabase,
    createWorkerOutboxHandlers,
    createWorkerNoticeHandlers,
    CREDENTIAL_NOTICE_QUEUE,
    runOutboxBatch,
    runQueueBatch,
    ClientRequestMailer,
    UsageThresholdMailer,
    StorageRootMailer,
    CredentialChangeMailer,
    PrivacyMailer,
    CollaborationMailer,
    createApprovalEmailSettler,
    writeHeartbeat,
    readHeartbeat,
    createEmailSuppressionLookup,
    createBounceSuppressionLookup,
  } = worker;
  const {
    BounceGuardMailer,
    ConsoleMailer,
    NotificationMailTransport,
    SendCeilingMailer,
    SmtpMailer,
    deriveBounceKey,
    deriveUnsubscribeKey,
    withTemplateKey,
  } = await import('@tmanage/mail');

  const from = { fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME };
  const driver =
    env.EMAIL_DRIVER === 'console'
      ? new ConsoleMailer(from)
      : env.SMTP_HOST
        ? new SmtpMailer({
            ...from,
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            username: env.SMTP_USERNAME,
            password: env.SMTP_PASSWORD,
            // 56-26: company mail gets the signed Message-ID its bounce is matched by.
            bounceKey: deriveBounceKey(env.SESSION_SECRET),
          })
        : null;

  const database = createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: Math.min(2, env.DATABASE_POOL_MAX),
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`worker connection rejected: ${serializeForLog(error)}`),
  });
  // 51-11: every send passes the host ceiling (§9.2); notification mail also goes through the
  // suppression list and carries the signed one-click List-Unsubscribe headers. Privacy and
  // credential notices stay transactional — no unsubscribe, never suppressed.
  // 56-26: company mail to an address that bounced in that company is held (auth mail never).
  const transport =
    driver === null
      ? null
      : new BounceGuardMailer(
          new SendCeilingMailer(driver),
          createBounceSuppressionLookup(database),
        );
  const notificationTransport =
    transport === null
      ? null
      : new NotificationMailTransport(transport, {
          unsubscribeUrl: `${env.API_PUBLIC_URL.replace(/\/+$/u, '')}/v1/public/email/unsubscribe`,
          key: deriveUnsubscribeKey(env.SESSION_SECRET),
          suppressions: createEmailSuppressionLookup(database),
        });
  // GROWTH-FIX: the scheduled jobs (growth report, security alerts, digests) mail through this
  // same stack, so the one in-memory send ceiling counts every mail this process sends.
  shareMail({
    alerts: transport,
    notice: (key) =>
      notificationTransport === null ? null : withTemplateKey(notificationTransport, key),
  });
  const relayHandlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(notificationTransport, env.WEB_PUBLIC_URL),
    usageThresholdMailer: new UsageThresholdMailer(notificationTransport),
    // 51-17 — the owners' "company storage at risk" mail.
    storageRootMailer: new StorageRootMailer(notificationTransport),
    // H3 — data export ready, deletion scheduled / cancelled / carried out.
    privacyMailer: new PrivacyMailer(transport, env.WEB_PUBLIC_URL),
    // QA-FIX-O H1: approval requests and decisions, mentions, meeting invites, project adds and
    // client actions. Missing here, live wrote those notices to the inbox and mailed none of them
    // (relay-mailers.test.mjs keeps this list equal to apps/worker/src/main.ts).
    collaborationMailer: new CollaborationMailer(
      notificationTransport === null
        ? null
        : withTemplateKey(notificationTransport, 'collaboration_notice'),
      env.WEB_PUBLIC_URL,
    ),
    approvalEmailSettler: createApprovalEmailSettler(database),
  });
  // R7 slice 5: link previews ride `message.created.v1`, with the card frame when sockets run.
  // DC-3 / RT-2: no chat or work frames here — every copy's realtime tail sends those
  // (startRealtime), so a socket on a copy that does not lead still gets them.
  const handlers = leaderRelayHandlers(worker, relayHandlers, database, realtimeHub);
  const noticeHandlers = createWorkerNoticeHandlers({
    credentialChangeMailer: new CredentialChangeMailer(transport),
  });
  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  // C10. A failed or parked job mails ALERT_EMAILS (at most once per 15 min per kind); a clean
  // pass records the heartbeat GET /healthz/deep reads (job-alerts.mjs).
  const alerts = createGroupedAlertNotifier(parseAlertEmails(env.ALERT_EMAILS), transport);
  let running = false;
  const tick = async () => {
    if (running || !mayRun()) return;
    running = true;
    try {
      const outbox = await runOutboxBatch(database, handlers, options);
      await reportJobOutcome(alerts, 'outbox', { report: outbox });
      const notices = await runQueueBatch(
        database,
        CREDENTIAL_NOTICE_QUEUE,
        noticeHandlers,
        options,
      );
      await reportJobOutcome(alerts, 'notices', { report: notices });
      await beat(writeHeartbeat, env.OUTBOX_HEARTBEAT_FILE);
    } catch (error) {
      log(`worker batch failed: ${serializeForLog(error)}`);
      await reportJobOutcome(alerts, 'relay', { error });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), env.OUTBOX_POLL_INTERVAL_MS);
  timer.unref();
  // 51-07. A stale heartbeat (wedged or dead relay) mails ALERT_EMAILS once per stale spell.
  const watchdog = createHeartbeatWatchdog({
    alerts,
    readHeartbeat,
    path: env.OUTBOX_HEARTBEAT_FILE,
    maxAgeSeconds: env.OUTBOX_HEARTBEAT_MAX_AGE_SECONDS,
  });
  const watchdogTimer = setInterval(() => void watchdog.check(), WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
  log(`in-process worker on, polling every ${env.OUTBOX_POLL_INTERVAL_MS}ms`);
  void tick();
  return async () => {
    clearInterval(timer);
    clearInterval(watchdogTimer);
    await database.end();
  };
}

/**
 * H2 / DC-3 / RT-2 — live pushes, on EVERY copy (not leader-gated). The worker's socket server
 * runs attached to this process's public port (realtime-inprocess.mjs), and this copy's realtime
 * tail frames its own sockets from the published outbox rows; it claims nothing, so any number of
 * copies run it at once. Its own pool of ONE connection (the host allows 25 per database user,
 * ADR-0010): the socket's subscription checks and the tail's reads are short and take turns.
 * Off (`REALTIME_INPROCESS=0`, or no relay configured), the clients refetch.
 */
async function startRealtime(env, attachRealtime) {
  const worker = await import('@tmanage/worker');
  const database = worker.createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: 1,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`realtime connection rejected: ${serializeForLog(error)}`),
  });
  const realtime = await worker.createRealtimeServer({
    database,
    sessionSecret: env.SESSION_SECRET,
    port: 'attached',
  });
  attachRealtime(realtime);
  const tail = startRealtimeTail({
    worker,
    database,
    hub: realtime.hub,
    intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    log,
    describeError: serializeForLog,
  });
  void tail.poll();
  log(`realtime on this copy, tailing the outbox every ${env.OUTBOX_POLL_INTERVAL_MS}ms`);
  return {
    hub: realtime.hub,
    async stop() {
      tail.stop();
      await realtime.close();
      await database.end();
    },
  };
}

/**
 * The scheduled sweeps — on unless `SWEEPS_INPROCESS=0`. Replaces every Hostinger cron entry:
 * the worker's `--sweep-*` commands and the API's `sweep:once` every minute, the API's
 * `reconcile:once` on its own hourly scheduler. The cadences, the switch and why two instances
 * cannot double-run are in scheduled-sweeps.mjs. The worker sweeps get their own one-connection
 * pool on the worker's credential, so they run with or without the relay; the API passes run on
 * the in-process API application `app`, exactly as `sweep.ts` and `reconcile.ts` compose it.
 *
 * DC-3 / RT-3: every pass goes through the named-lock runner, and that runner is gated by the
 * leader lease (`leaderGatedLock`), so only the leading copy runs a sweep or a job.
 */
async function startScheduledSweeps(env, app, mail, holds = () => true) {
  const worker = await import('@tmanage/worker');
  const database = worker.createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: 1,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`sweep connection rejected: ${serializeForLog(error)}`),
  });
  // LOGQUIET-a: one named lock per sweep, on a connection of its own (scheduled-sweeps.mjs);
  // DC-3: refused while this copy does not hold the leader lease.
  const lock = leaderGatedLock(
    worker.createSweepLockDatabase({ url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL }),
    holds,
  );
  const api = { UPLOAD_SESSION_SWEEPER, USAGE_RECONCILER, describeSweep, describeReconciliation };
  const scheduler = createSweepScheduler({
    jobs: [...workerSweepJobs(worker, database), ...apiSweepJobs(api, app)],
    intervalMs: sweepIntervalMs(process.env),
    log,
    describeError: serializeForLog,
    lock,
  });
  const reconciler = createSweepScheduler({
    jobs: apiReconcileJobs(api, app),
    intervalMs: reconcileIntervalMs(process.env),
    log,
    describeError: serializeForLog,
    lock,
  });
  scheduler.start();
  reconciler.start();
  // R14-a: outbound webhooks are delivered here; the relay only stages them (R13-s2).
  const stopWebhooks = startWebhookDeliveries(worker, database, env, log, serializeForLog, lock);
  // R16-b: the 15-minute budget burn sweep (52-05).
  const stopBudgetBurn = startBudgetBurn(worker, database, env, log, serializeForLog, lock);
  // R17-d: the hourly retainer period roll (52-06).
  const stopRetainerRoll = startRetainerRoll(worker, database, env, log, serializeForLog, lock);
  // 62-A2: the activity projector, every minute (audit events -> activity_entries).
  const stopActivity = startActivityProjector(worker, database, env, log, serializeForLog, lock);
  // 62-27: the hourly signals sweep, only where `business_briefing` is on.
  const stopSignals = startSignalsSweep(worker, database, env, log, serializeForLog, lock);
  // GROWTH-FIX: the worker's recurring jobs (growth rollups, finance facts, chain checks, digests,
  // anchors, purges, key rotation, timers, security detector) on a one-connection pool of their
  // own, so a long nightly rebuild never holds the minute sweeps' connection (ST-5).
  const jobsDatabase = worker.createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: 1,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`jobs connection rejected: ${serializeForLog(error)}`),
  });
  const stopJobs = startScheduledJobs(worker, jobsDatabase, env, mail, log, serializeForLog, lock);
  return async () => {
    await Promise.all([
      scheduler.stop(),
      reconciler.stop(),
      stopWebhooks?.(),
      stopBudgetBurn?.(),
      stopRetainerRoll?.(),
      stopActivity?.(),
      stopSignals?.(),
      stopJobs?.(),
    ]);
    await Promise.all([database.end(), jobsDatabase.end(), lock.end()]);
  };
}

/**
 * DC-3 / RT-3. The leader lease on a one-connection pool of its own (ST-5: a long sweep never
 * holds the connection a renewal needs). `onLeader` starts the duties the first time this copy
 * leads, with the gate every pass must ask; until then (and whenever it does not lead) this copy
 * serves web traffic only.
 */
async function startLeadership(env, onLeader) {
  const worker = await import('@tmanage/worker');
  const database = worker.createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: 1,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`lease connection rejected: ${serializeForLog(error)}`),
  });
  const store = worker.createLeaseStoreDatabase(database);
  const lease = worker.createLeaderLease({ store, holder: worker.newLeaseHolder() });
  log(`instance ${lease.holder} is pid ${String(process.pid)}`);
  const leadership = createLeadership({
    lease,
    intervalMs: worker.LEADER_LEASE_RENEW_MS,
    log,
    describeError: serializeForLog,
    onLeader: () => onLeader(() => leadership.holds()),
  });
  await leadership.start();
  return {
    dutiesStarted: () => leadership.dutiesStarted(),
    async stop() {
      await leadership.stop();
      await store.end();
    },
  };
}

async function main() {
  const port = Number(process.env['PORT'] ?? 3000);

  // The private transport to the web child: a 0700 directory and 0600 socket under the app dir
  // (a named pipe on Windows; TMANAGE_WEB_TRANSPORT=tcp for loopback TCP in local development).
  const transport = prepareWebTransport(
    resolveWebTransport({
      env: process.env,
      platform: process.platform,
      root: ROOT,
      publicPort: port,
    }),
  );
  // However this process ends (process.exit included), remove the socket and stop the child.
  process.on('exit', () => {
    stopWebSupervision();
    cleanupWebTransport(transport);
    try {
      webChildRef?.kill('SIGTERM');
    } catch {
      // already gone
    }
  });

  // Listen FIRST: LiteSpeed restarts an app that has not opened its port within ~3 s. Every
  // request — /healthz included — answers 503 "starting" until `state.ready` is set below.
  const state = { ready: undefined };
  // FIX6: the server-rendered sign-in/sign-up/setup pages get a per-address limit (page-limit.mjs).
  const pageLimit = createPageLimiter({ trustedProxies: process.env['TRUSTED_PROXY_ADDRESSES'] });
  const toWeb = (req, res) => proxyToWeb(req, res, transport);
  // PLATFORMFIX: who may see Platform admin is decided here, by the API, before the web child
  // renders any of its shell (platform-gate.mjs).
  const platformGate = createPlatformGate({
    inject: (options) => state.ready.fastify.inject(options),
    proxyToWeb: toWeb,
    log,
    // AUTHSTATE: the browser-readable cookie that says a refreshable session may exist.
    csrfCookieName: `${process.env['SESSION_COOKIE_NAME'] || 'tmanage_session'}_csrf`,
  });
  const publicHandler = createPublicHandler(
    state,
    (req, res) => {
      if (pageLimit(req, res)) return;
      if (isPlatformPath(req.url)) platformGate(req, res);
      else toWeb(req, res);
    },
    resolve(ROOT, DOWNLOADS_DIR),
  );
  // 56-01. The client address is read by the API's own rule (TRUSTED_PROXY_ADDRESSES, D09).
  const cspReport = createCspReportHandler({
    trustedProxies: process.env['TRUSTED_PROXY_ADDRESSES'],
    log,
  });
  // 56-17. RFC 9116 security.txt, served whatever the boot state (no dependency).
  const securityTxt = createSecurityTxtHandler(process.env);
  // ST-3: explicit request, headers and keep-alive limits for the hop behind Hostinger's proxy.
  const server = createPublicServer((req, res) => {
    if (state.ready && isCspReportPath(req.url)) cspReport(req, res);
    else if (isSecurityTxtPath(req.url)) securityTxt(req, res);
    else publicHandler(req, res);
  });
  // H2: WebSocket upgrades go to the attached realtime socket once the app is ready; any other
  // upgrade (or one while starting) is closed.
  let realtimeServer;
  server.on(
    'upgrade',
    createUpgradeHandler(() => (state.ready ? realtimeServer : undefined)),
  );
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', fail);
      done();
    });
  });
  log(`listening on :${port} (starting; web child on ${describeWebTransport(transport)})`);
  bootMark('listening');

  // Shutdown works at any point of the boot: whatever has started is stopped.
  let app;
  let stopWorker;
  /** GROWTH-FIX: the relay's mail, shared with the scheduled jobs; `undefined` without a relay. */
  let jobMail;
  let stopSweeps;
  /** DC-3: the leader lease, once background duties are configured. */
  let leadership;
  /** RT-2: this copy's socket server and realtime tail (every copy, not leader-gated). */
  let realtime;
  // A signal during the migrations waits for the file in progress (bounded) before exiting.
  const migrationGate = createMigrationGate({ log });
  const shutdown = (signal) => {
    if (migrationGate.stopping) {
      log(`${signal} — already shutting down`);
      return;
    }
    migrationGate.requestStop();
    log(`${signal} — shutting down`);
    stopWebSupervision();
    server.close();
    try {
      webChildRef?.kill('SIGTERM');
    } catch {
      // already gone
    }
    void (async () => {
      try {
        await migrationGate.settle();
        // Duties still starting are let finish starting, so they can be stopped below.
        await leadership?.dutiesStarted();
        // The sweeps first: their jobs mail through the relay's transport and pool.
        await stopSweeps?.();
        await stopWorker?.();
        await realtime?.stop();
        // DC-3: hand the lease over only after the duties stopped, so the next copy leads at once
        // without overlapping this one.
        await leadership?.stop();
        await app?.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Hostinger's own database variables (DATABASE_URL, or DB_*), its one database user, and its
  // 127.0.0.1-only grant — resolved before validation. The values hold the password: only the
  // notes are logged.
  const database = resolveDatabaseEnv(process.env);
  Object.assign(process.env, database.values);
  for (const note of database.notes) log(note);
  // H2: the socket URL the API serves beside the ticket, derived same-origin when not set.
  log(applyRealtimePublicUrl(process.env));
  // FIGMA lane (2026-11-10): Figma frame snapshots are drawn in this one process, with or without
  // the relay (live has no separate worker, and its variables cannot be changed). `0` turns it off.
  process.env['FIGMA_SNAPSHOT_INPROCESS'] ??= '1';

  const env = loadEnv();
  await runMigrations(env, migrationGate);
  bootMark('migrations done');
  // A signal arrived during the migrations: the shutdown above owns the exit; boot goes no further.
  if (migrationGate.stopping) return;

  const api = await createApi(env);
  // The API is in-process (no port of its own): this marks Nest initialised and Fastify ready.
  bootMark('api ready');
  app = api.app;
  // 51-13a. An exception nothing caught (or an unhandled rejection) mails ALERT_EMAILS through the
  // API's notifier — at most once per 15 minutes across restarts — then exits 1 as Node would.
  let crashAlerts = null;
  try {
    crashAlerts = app.get(Symbol.for('tmanage.AlertNotifier'), { strict: false });
  } catch {
    // no notifier registered: crashes are only logged
  }
  installProcessAlerts(process, crashAlerts, {
    log,
    describe: serializeForLog,
    stateFile: resolve(ROOT, '.crash-alert.json'),
    fs: { readFileSync, writeFileSync },
  });
  // The port the child is told to use: real on TCP, nominal (never bound) on a socket.
  const nominalPort = transport.kind === 'tcp' ? transport.port : port + 1;
  // RT-4 (SRV-2): ready once the API and the web child answer; the relay and the sweeps start
  // after, so a slow worker never lengthens the 503 window.
  await becomeReady({
    startWeb: async () => {
      await startWeb(transport, nominalPort);
      bootMark('web ready');
    },
    markReady: () => {
      state.ready = { fastify: api.fastify };
      log(`ready on :${port} (web via ${describeWebTransport(transport)}, /v1 API in-process)`);
    },
    startBackground: async () => {
      const relayOn = process.env['WORKER_INPROCESS'] === '1';
      const sweepsOn = sweepsEnabled(process.env);
      if (!sweepsOn) log('scheduled sweeps off (SWEEPS_INPROCESS)');
      if (!relayOn && !sweepsOn) return;
      // RT-2: sockets and their frames on every copy, before (and whatever) the lease decides.
      if (realtimeInProcessEnabled(process.env)) {
        realtime = await startRealtime(env, (server) => {
          realtimeServer = server;
        });
      }
      // DC-3 / RT-3: only the copy holding the leader lease runs the relay, sweeps and jobs;
      // every copy serves web traffic. Started once, the first time this copy leads.
      leadership = await startLeadership(env, async (holds) => {
        if (relayOn) {
          stopWorker = await startInProcessWorker(
            env,
            realtime?.hub,
            (mail) => {
              jobMail = mail;
            },
            holds,
          );
        }
        if (sweepsOn) stopSweeps = await startScheduledSweeps(env, app, jobMail, holds);
      });
    },
  });
}

main().catch((error) => {
  const detail = error instanceof MigrationError ? error.message : serializeForLog(error);
  process.stderr.write(`[server] failed to start\n${detail}\n`);
  // The exit handler removes the socket and stops a web child that had already started.
  process.exit(1);
});
