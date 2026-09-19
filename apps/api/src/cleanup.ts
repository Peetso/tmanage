import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@tmanage/config';
import { composeAppModule } from './app-composition.js';
import { serializeForLog } from './common/observability/logger.js';
import { TENANT_DATABASE, QUARANTINE_CLEANUP_JOB } from './common/http/tokens.js';
import type { TenantDatabase } from './common/database/tenant-context.js';
import { describeCleanup } from './modules/files/quarantine-cleanup.js';
import type { QuarantineCleanupJob } from './modules/files/quarantine-cleanup.js';

/**
 * FILE-003's job entry point: one pass of the quarantine / rejected-object retention
 * lifecycle, then exit.
 *
 * `sweep.ts`'s and `reconcile.ts`'s shape, for their reason: `50-BOOTSTRAP` §3's host cannot
 * keep a third process alive, so the external tick that runs `relay:once`, `sweep:once`,
 * `verify:once` and `reconcile:once` runs `cleanup:once` after them. There is no loop mode —
 * the `--once` flag is accepted for symmetry with the relay and is the only behaviour.
 *
 * The application is composed exactly as the HTTP process composes it (`app-composition.ts`),
 * as a context rather than a server, so the pass deletes and decrements through the same object
 * store, counters, ledger and audit the routes use: a purge here is written with the same
 * outbox event and audit row a route's write would be. One report line on stderr,
 * `[cleanup] pass: …`, distinct from the sweeper's, the verifier's and the reconciler's so a
 * harness parsing one never reads another. A failed asset is counted in it and named on its own
 * `console.error` line; the exit code is non-zero only when the pass itself could not run,
 * because a tick that failed one object of a thousand should still be read as "ran".
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(composeAppModule(env), {
    logger: ['error', 'warn'],
  });
  const database = app.get<TenantDatabase>(TENANT_DATABASE);
  try {
    const job = app.get<QuarantineCleanupJob>(QUARANTINE_CLEANUP_JOB);
    const report = await job.cleanup();
    console.warn(`[cleanup] pass: ${describeCleanup(report)}`);
  } finally {
    await app.close();
    // As in `sweep.ts` and `reconcile.ts`: `app.close()` leaves the pool open, and a pool with
    // idle connections keeps the event loop alive. A job has to end its own pool to exit.
    await database.end();
  }
}

main().catch((error: unknown) => {
  // A fatal here is usually a failed app build or database connection carrying the DSN, so it is
  // redacted through the OBS-001 seam rather than printed raw.
  console.error('[cleanup] fatal', serializeForLog(error));
  process.exitCode = 1;
});
