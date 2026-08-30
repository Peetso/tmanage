import { loadEnv } from '@tmanage/config';
import type { Env } from '@tmanage/config';
import { ConsoleMailer, SmtpMailer } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { createWorkerDatabase } from './common/database/worker-database.js';
import { runOutboxBatch, runOutboxLoop } from './outbox/dispatcher.js';
import type { BatchReport } from './outbox/dispatcher.js';
import { createWorkerOutboxHandlers } from './consumers/registry.js';
import { ClientRequestMailer } from './notifications/client-request-mailer.js';
import { createRealtimeServer } from './realtime/server.js';
import { createMessageFanOut } from './realtime/fan-out.js';

/**
 * The worker process entry point.
 *
 * Two modes, per `50-BOOTSTRAP` §3's deployment reality:
 *
 * - **`--once`** runs a single controlled batch and exits with its report — the shape for
 *   a host that cannot keep a third Node process alive reliably. A scheduler (cron, a
 *   deploy hook, a hand) invokes `pnpm --filter @tmanage/worker relay:once` as often as
 *   delivery latency needs to be short.
 * - **No flag** runs the polling loop until SIGINT/SIGTERM, finishing the in-flight batch
 *   before leaving — the standalone-worker shape for a host that supports one.
 *
 * Everything tunable comes from `@tmanage/config` — the worker owns no `process.env`
 * reads beyond handing the bag to `loadEnv`, so a malformed variable fails loudly at boot
 * here exactly as it does in the API.
 *
 * `console.warn`/`console.error` are the process's log lines for now; OBS-001 is the
 * structured-logging ticket, and inventing half of it here would be scope this file does
 * not have. The report never contains payloads — see `BatchReport`.
 */

function describe(report: BatchReport): string {
  const parked = report.parked.length > 0 ? `, ${report.parked.length} parked` : '';
  // Effects are counted, never described: an effect failure's message is the driver's own
  // words and may name a recipient's address. The producer logs those itself, to the
  // operator's log and nowhere else.
  const effects =
    report.effects > 0
      ? `, ${report.effects} after-commit effect(s)` +
        (report.effectFailures.length > 0 ? ` of which ${report.effectFailures.length} failed` : '')
      : '';
  return (
    `claimed ${report.claimed}, published ${report.published} ` +
    `(${report.unhandled} with no consumer), failed ${report.failed}${parked}${effects}`
  );
}

/**
 * The relay's mail transport, chosen the way `MailerModule.forConfig` chooses the API's.
 *
 * `loadEnv` has already parsed and cross-validated every `EMAIL_*` and `SMTP_*` key — it is
 * one schema for the whole monorepo — so there is nothing to re-check here beyond the
 * narrowing TypeScript needs. `packages/config` refuses `EMAIL_DRIVER=smtp` without
 * `SMTP_HOST` at boot, which is why the fallback below is a type guard and not a policy.
 */
function mailerFrom(env: Env): Mailer | null {
  const from = { fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME };
  if (env.EMAIL_DRIVER === 'console') return new ConsoleMailer(from);
  if (env.SMTP_HOST === undefined || env.SMTP_HOST === '') return null;
  return new SmtpMailer({
    ...from,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const once = process.argv.includes('--once');

  const database = createWorkerDatabase({
    url: env.DATABASE_URL,
    connectionLimit: Math.min(env.DATABASE_POOL_MAX, 2),
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => {
      console.error('[worker] connection rejected during session setup', error);
    },
  });

  // The relay's own producer. The console driver counts as a transport — printing the
  // composed message is its whole job, and the bootstrap profile is where a developer reads
  // what a client would have received.
  const handlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(mailerFrom(env), env.WEB_PUBLIC_URL),
  });

  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  if (once) {
    try {
      const report = await runOutboxBatch(database, handlers, options);
      console.warn(`[worker] batch: ${describe(report)}`);
      for (const parked of report.parked) {
        console.error(
          `[worker] parked event ${parked.id} (${parked.type}) after ${parked.attempts} attempts`,
        );
      }
    } finally {
      await database.end();
    }
    return;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // RT-001. Sockets exist only in loop mode — a controlled batch has no process to keep a
  // socket open — and only when a port is configured; 0 is the honest default on a host
  // that cannot keep this process alive. The fan-out handler joins the registry only when
  // a hub actually exists, so batch deployments never claim events for nobody.
  const realtime =
    env.REALTIME_PORT > 0
      ? await createRealtimeServer({
          database,
          sessionSecret: env.SESSION_SECRET,
          port: env.REALTIME_PORT,
        })
      : undefined;
  if (realtime) console.warn(`[worker] realtime socket listening on :${realtime.port}`);

  const loopHandlers = realtime
    ? { ...handlers, 'message.created.v1': createMessageFanOut(realtime.hub) }
    : handlers;

  try {
    await runOutboxLoop(database, loopHandlers, {
      ...options,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      signal: controller.signal,
      onBatch: (report) => {
        if (report.claimed > 0 || report.parked.length > 0) {
          console.warn(`[worker] batch: ${describe(report)}`);
        }
      },
      onError: (error) => {
        console.error('[worker] batch failed whole', error);
      },
    });
  } finally {
    await realtime?.close();
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exitCode = 1;
});
