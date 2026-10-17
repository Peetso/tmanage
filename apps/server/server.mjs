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
//   * everything else is reverse-proxied, on loopback, to a Next.js production server
//     (`next start`) this process launches as a child.
//
// Why a child `next start` rather than Next's programmatic request handler: Next 16 builds with
// Turbopack, and a Turbopack production build served through the programmatic custom server does
// not wire preview-mode props into SSR (pages 500). `next start` is the server that build is made
// for. Running it on loopback and proxying to it keeps the whole app on one public port and one
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
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '@tmanage/config';
import { createPartAdmission } from '@tmanage/storage';
import { NestFactory } from '@nestjs/core';

import {
  composeAppModule,
  corsOptions,
  createFastifyAdapter,
  createFixedWindowLimiter,
  migrateOnStart,
  MigrationError,
  serializeForLog,
} from '@tmanage/api/hostinger';

import { isApiPath, webSecurityHeaders } from './boot-guards.mjs';
import { resolveDatabaseEnv } from './database-env.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.env['TMANAGE_WEB_DIR'] ?? resolve(ROOT, 'web');
const MIGRATIONS_DIR = process.env['TMANAGE_MIGRATIONS_DIR'] ?? resolve(ROOT, 'migrations');

function log(message) {
  process.stderr.write(`[server] ${message}\n`);
}

/**
 * Apply the schema on start — guarded, idempotent, locked.
 *
 * The migrator holds a MySQL advisory lock for its whole run, refuses to touch a partially
 * applied schema, and is a no-op when nothing is pending (the second start proves it). A failure
 * stops boot: a process serving a half-migrated schema is the outage the migrator prevents.
 */
async function runMigrations(env) {
  const report = await migrateOnStart(env.DATABASE_MIGRATION_URL, {
    directory: MIGRATIONS_DIR,
    appliedBy: 'hostinger-bundle',
    log,
  });
  log(
    report.applied.length === 0
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

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const attempt = () => {
      const socket = createConnection(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        done();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) fail(new Error(`web server never opened :${port}`));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** Launch `next start` on a loopback port and resolve once it is accepting connections. */
async function startWeb(webPort) {
  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(
    process.execPath,
    [nextBin, 'start', '-p', String(webPort), '-H', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        // PORT is overridden so the child binds its loopback port, not the public one this
        // process owns; HOSTNAME keeps it off the public interface.
        PORT: String(webPort),
        HOSTNAME: '127.0.0.1',
        // next.config.ts re-runs its public-config validation when `next start` loads it, so the
        // same values the build inlined must be present. The /v1 rewrite they imply is never used
        // (this process answers /v1 before the web child sees it), so the proxy target is a
        // harmless loopback placeholder.
        NEXT_PUBLIC_API_BASE_URL: process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'same-origin',
        NEXT_PUBLIC_SESSION_COOKIE_NAME:
          process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'] ?? 'tmanage_session',
        API_PROXY_TARGET: process.env['API_PROXY_TARGET'] ?? `http://127.0.0.1:${webPort}`,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  child.on('exit', (code) => {
    log(`next start exited (${code}) — shutting down`);
    process.exit(code ?? 1);
  });
  await waitForPort(webPort, 180_000);
  return child;
}

/** Reverse-proxy one request to the loopback web server, streaming both ways. */
function proxyToWeb(req, res, webPort) {
  const upstream = httpRequest(
    { host: '127.0.0.1', port: webPort, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      // HSTS on every page response, and a report-only CSP on HTML (security review §3).
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...webSecurityHeaders(up.headers) });
      up.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    log(`web proxy error: ${serializeForLog(error)}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

/**
 * The in-process outbox relay — on only when `WORKER_INPROCESS=1`.
 *
 * Runs the worker's own `relay:once` batch on a timer inside this process, so a plan that cannot
 * keep a third Node process alive still delivers mail and notifications. Limitation (documented):
 * when Hostinger sleeps the app, the timer sleeps too, so delivery resumes on the next request.
 */
async function startInProcessWorker(env) {
  const {
    createWorkerDatabase,
    createWorkerOutboxHandlers,
    createWorkerNoticeHandlers,
    CREDENTIAL_NOTICE_QUEUE,
    runOutboxBatch,
    runQueueBatch,
    ClientRequestMailer,
    UsageThresholdMailer,
    CredentialChangeMailer,
  } = await import('@tmanage/worker');
  const { ConsoleMailer, SmtpMailer } = await import('@tmanage/mail');

  const from = { fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME };
  const transport =
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
          })
        : null;

  const database = createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: Math.min(2, env.DATABASE_POOL_MAX),
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => log(`worker connection rejected: ${serializeForLog(error)}`),
  });
  const handlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(transport, env.WEB_PUBLIC_URL),
    usageThresholdMailer: new UsageThresholdMailer(transport),
  });
  const noticeHandlers = createWorkerNoticeHandlers({
    credentialChangeMailer: new CredentialChangeMailer(transport),
  });
  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOutboxBatch(database, handlers, options);
      await runQueueBatch(database, CREDENTIAL_NOTICE_QUEUE, noticeHandlers, options);
    } catch (error) {
      log(`worker batch failed: ${serializeForLog(error)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), env.OUTBOX_POLL_INTERVAL_MS);
  timer.unref();
  log(`in-process worker on, polling every ${env.OUTBOX_POLL_INTERVAL_MS}ms`);
  void tick();
  return async () => {
    clearInterval(timer);
    await database.end();
  };
}

async function main() {
  const port = Number(process.env['PORT'] ?? 3000);
  // A loopback port for the web child. Overridable; defaults just above the public port.
  const webPort = Number(process.env['WEB_INTERNAL_PORT'] ?? port + 1);

  // Hostinger's own database variables (DATABASE_URL, or DB_*), its one database user, and its
  // 127.0.0.1-only grant — resolved before validation. The values hold the password: only the
  // notes are logged.
  const database = resolveDatabaseEnv(process.env);
  Object.assign(process.env, database.values);
  for (const note of database.notes) log(note);

  const env = loadEnv();
  await runMigrations(env);

  const { app, fastify } = await createApi(env);
  const webChild = await startWeb(webPort);

  const server = createHttpServer((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (isApiPath(req.url)) {
      fastify.routing(req, res);
      return;
    }
    proxyToWeb(req, res, webPort);
  });

  const stopWorker =
    process.env['WORKER_INPROCESS'] === '1' ? await startInProcessWorker(env) : undefined;

  await new Promise((done) => server.listen(port, '0.0.0.0', done));
  log(`listening on :${port} (web proxied from :${webPort}, /v1 API in-process)`);

  const shutdown = (signal) => {
    log(`${signal} — shutting down`);
    server.close();
    try {
      webChild.kill('SIGTERM');
    } catch {
      // already gone
    }
    void (async () => {
      try {
        await stopWorker?.();
        await app.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  const detail = error instanceof MigrationError ? error.message : serializeForLog(error);
  process.stderr.write(`[server] failed to start\n${detail}\n`);
  process.exit(1);
});
