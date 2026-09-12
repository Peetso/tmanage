import { loadEnv } from '@tmanage/config';
import type { Env } from '@tmanage/config';
import { ConsoleMailer, SmtpMailer } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { createWorkerDatabase } from './common/database/worker-database.js';
import { readOutboxBacklog } from './common/database/outbox-store.js';
import { runOutboxBatch, runOutboxLoop } from './outbox/dispatcher.js';
import type { BatchReport } from './outbox/dispatcher.js';
import {
  backlogIsStale,
  describeHealth,
  evaluateOutboxHealth,
  readHeartbeat,
  writeHeartbeat,
} from './outbox/health.js';
import type { OutboxHealthThresholds } from './outbox/health.js';
import { createWorkerOutboxHandlers } from './consumers/registry.js';
import { ClientRequestMailer } from './notifications/client-request-mailer.js';
import { createRealtimeServer } from './realtime/server.js';
import { createMessageFanOut } from './realtime/fan-out.js';

/**
 * The worker process entry point.
 *
 * Three modes, per `50-BOOTSTRAP` §3's deployment reality:
 *
 * - **`--once`** runs a single controlled batch and exits with its report — the shape for
 *   a host that cannot keep a third Node process alive reliably. A scheduler (cron, a
 *   deploy hook, a hand) invokes `pnpm --filter @tmanage/worker relay:once` as often as
 *   delivery latency needs to be short. **It exits 1 when the oldest undelivered event is
 *   older than `OUTBOX_BACKLOG_MAX_AGE_SECONDS`**, so cron's own failure reporting becomes
 *   the alarm the audit found missing (CRITICAL-2). A batch that merely fails an event
 *   still exits 0 — the retry is the design, and a page per transient failure is a page
 *   nobody reads.
 * - **`--status`** delivers nothing and reports: backlog age, parked count, and how long
 *   ago a batch last finished, as one JSON line, exiting 1 when any of those is past its
 *   threshold. The monitoring surface for a host that has no spare port for the worker to
 *   answer on — `pnpm --filter @tmanage/worker relay:status`, from cron or an uptime check.
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
  // Backlog age on every line, not only when something was claimed: the whole point of
  // CRITICAL-2 is that "nothing was claimed" and "nothing is running" must stop looking alike.
  const oldest = report.backlog.oldestPendingSeconds;
  const backlog =
    `, backlog ${report.backlog.pending} pending` + (oldest === null ? '' : `, oldest ${oldest}s`);
  return (
    `claimed ${report.claimed}, published ${report.published} ` +
    `(${report.unhandled} with no consumer), failed ${report.failed}${parked}${effects}${backlog}`
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

/**
 * Record that a batch finished, if a path was configured.
 *
 * Failure to write is logged and swallowed on purpose: the relay's job is delivery, and a
 * heartbeat it could not write goes stale on its own — which a monitor reads as unhealthy,
 * correctly, since a worker whose disk refuses writes is not well.
 */
async function beat(path: string | undefined, at: Date): Promise<void> {
  if (path === undefined) return;
  try {
    await writeHeartbeat(path, at);
  } catch (error) {
    console.error('[worker] could not write heartbeat', error);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const once = process.argv.includes('--once');
  const status = process.argv.includes('--status');
  const thresholds: OutboxHealthThresholds = {
    backlogMaxAgeSeconds: env.OUTBOX_BACKLOG_MAX_AGE_SECONDS,
    heartbeatMaxAgeSeconds: env.OUTBOX_HEARTBEAT_MAX_AGE_SECONDS,
  };

  // The relay's own least-privilege credential when it is set; the API's otherwise, named
  // on stderr so nobody reads a development fallback as the production shape.
  console.warn(
    `[worker] database credential: ${env.WORKER_DATABASE_URL ? 'WORKER_DATABASE_URL' : 'DATABASE_URL (WORKER_DATABASE_URL not set)'}`,
  );
  const database = createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: Math.min(env.DATABASE_POOL_MAX, 2),
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => {
      console.error('[worker] connection rejected during session setup', error);
    },
  });

  // Report and leave: no handlers are built, nothing is claimed, and the only statement is
  // the aggregate read. Safe to run from cron beside a live loop, and safe to run on a
  // schedule of its own on a host where the relay is cron-driven batches.
  if (status) {
    try {
      const backlog = await database.read((tx) => readOutboxBacklog(tx, env.OUTBOX_MAX_ATTEMPTS));
      const lastPollAt =
        env.OUTBOX_HEARTBEAT_FILE === undefined
          ? null
          : await readHeartbeat(env.OUTBOX_HEARTBEAT_FILE);
      const health = evaluateOutboxHealth({
        backlog,
        lastPollAt,
        now: new Date(),
        thresholds,
      });
      // One JSON line on stdout for a machine, one sentence on stderr for a person. Written
      // directly rather than through `console` because stdout here is a data channel — a
      // caller pipes it to `jq` — and the workspace's `no-console` rule reserves `console`
      // for the operator's log, which is stderr. The exit code is the contract: 0 draining,
      // 1 not. Nothing in the line names an organization, a recipient or a payload.
      process.stdout.write(`${JSON.stringify(health)}\n`);
      console.warn(`[worker] outbox ${describeHealth(health)}`);
      if (health.status !== 'ok') process.exitCode = 1;
    } finally {
      await database.end();
    }
    return;
  }

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
      await beat(env.OUTBOX_HEARTBEAT_FILE, new Date());
      console.warn(`[worker] batch: ${describe(report)}`);
      for (const parked of report.parked) {
        console.error(
          `[worker] parked event ${parked.id} (${parked.type}) after ${parked.attempts} attempts`,
        );
      }
      // The alarm, in the one place a cron-driven deployment can hear it. Backlog age only:
      // an event that failed this batch is due to be retried and is not yet a problem, but
      // an event nobody has delivered for longer than the threshold is, whatever the cause.
      if (backlogIsStale(report.backlog, thresholds.backlogMaxAgeSeconds)) {
        console.error(
          `[worker] outbox backlog is ${String(report.backlog.oldestPendingSeconds)}s old, ` +
            `over the ${String(thresholds.backlogMaxAgeSeconds)}s threshold — the relay is not draining`,
        );
        process.exitCode = 1;
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
        // The heartbeat is the loop's half of CRITICAL-2: a batch that completed is the
        // only evidence this process is alive, and it must be recorded whether or not the
        // batch had anything to do. Fire-and-forget — `beat` swallows its own failures and
        // the loop must not wait on a disk to keep delivering.
        void beat(env.OUTBOX_HEARTBEAT_FILE, new Date());
        if (report.claimed > 0 || report.parked.length > 0) {
          console.warn(`[worker] batch: ${describe(report)}`);
        } else if (backlogIsStale(report.backlog, thresholds.backlogMaxAgeSeconds)) {
          // Claimed nothing, yet something has been waiting past the threshold: rows exist
          // that this relay cannot take — parked, or locked by another process that is not
          // draining them. Silence here is what the audit found; this is the line.
          console.error(`[worker] outbox not draining: ${describe(report)}`);
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
