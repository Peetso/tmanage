import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@tmanage/config';
import { composeAppModule } from './app-composition.js';
import { serializeForLog } from './common/observability/logger.js';
import { TENANT_DATABASE, USAGE_RECONCILER } from './common/http/tokens.js';
import type { TenantDatabase } from './common/database/tenant-context.js';
import { describeReconciliation } from './modules/files/usage-reconciler.js';
import type { UsageReconciler } from './modules/files/usage-reconciler.js';

/**
 * USAGE-001 slice 3's job entry point: one pass reconciling every organization's storage
 * counter against its append-only ledger, then exit.
 *
 * `sweep.ts`'s shape, for its reason: `50-BOOTSTRAP` §3's host cannot keep a third process
 * alive, so the external tick that runs `relay:once`, `sweep:once` and `verify:once` runs
 * `reconcile:once` after them (USAGE-001 decision 10). There is no loop mode — the `--once`
 * flag is accepted for symmetry with the relay and is the only behaviour.
 *
 * The application is composed exactly as the HTTP process composes it
 * (`app-composition.ts`), as a context rather than a server, so the pass reads and repairs
 * through the same counters, ledger and audit the routes use: a correction here is written
 * with the same audit row a route's write would be. One report line on stderr,
 * `[reconciler] pass: …`, distinct from the sweeper's and the verifier's so a harness parsing
 * one never reads another. A failed organization is counted in it and named on its own
 * `console.error` line; the exit code is non-zero only when the pass itself could not run,
 * because a tick that failed one organization of a thousand should still be read as "ran".
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(composeAppModule(env), {
    logger: ['error', 'warn'],
  });
  const database = app.get<TenantDatabase>(TENANT_DATABASE);
  try {
    const reconciler = app.get<UsageReconciler>(USAGE_RECONCILER);
    const report = await reconciler.reconcile();
    console.warn(`[reconciler] pass: ${describeReconciliation(report)}`);
  } finally {
    await app.close();
    // As in `sweep.ts`: `app.close()` leaves the pool open, and a pool with idle connections
    // keeps the event loop alive. A job has to end its own pool so the process can exit.
    await database.end();
  }
}

main().catch((error: unknown) => {
  // As in `sweep.ts`: a fatal here usually carries the DSN, so it is redacted through OBS-001.
  console.error('[reconciler] fatal', serializeForLog(error));
  process.exitCode = 1;
});
