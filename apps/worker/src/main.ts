import { loadEnv } from '@tmanage/config';
import { createWorkerDatabase } from './common/database/worker-database.js';
import { runOutboxBatch, runOutboxLoop } from './outbox/dispatcher.js';
import type { BatchReport } from './outbox/dispatcher.js';
import { WORKER_OUTBOX_HANDLERS } from './consumers/registry.js';
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
  return (
    `claimed ${report.claimed}, published ${report.published} ` +
    `(${report.unhandled} with no consumer), failed ${report.failed}${parked}`
  );
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

  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  if (once) {
    try {
      const report = await runOutboxBatch(database, WORKER_OUTBOX_HANDLERS, options);
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

  const handlers = realtime
    ? { ...WORKER_OUTBOX_HANDLERS, 'message.created.v1': createMessageFanOut(realtime.hub) }
    : WORKER_OUTBOX_HANDLERS;

  try {
    await runOutboxLoop(database, handlers, {
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
