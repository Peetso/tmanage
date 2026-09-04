import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@tmanage/config';
import { composeAppModule } from './app-composition.js';
import { TENANT_DATABASE, UPLOAD_SESSION_SWEEPER } from './common/http/tokens.js';
import type { TenantDatabase } from './common/database/tenant-context.js';
import { describeSweep } from './modules/files/upload-session-sweeper.js';
import type { UploadSessionSweeper } from './modules/files/upload-session-sweeper.js';

/**
 * USAGE-001's job entry point: one sweep of expired upload reservations, then exit.
 *
 * The relay's shape (`apps/worker/src/main.ts`, `--once`), for the relay's reason:
 * `50-BOOTSTRAP` §3's host cannot keep a third process alive, so the external tick that
 * runs `relay:once` runs `sweep:once` after it — decision 10 — and a pass has to be a
 * process with a natural end. There is no loop mode: the `--once` flag is accepted for
 * symmetry with the relay and is the only behaviour.
 *
 * The application is composed exactly as the HTTP process composes it
 * (`app-composition.ts`) but as a context rather than a server: no adapter, no port, the
 * same modules. The sweeper is resolved from `FilesModule`, which built it on the same
 * `FilesService` the routes use, so an expiry here is the release a cancel would be.
 *
 * One report line on stderr, in the worker's idiom — `console.warn` is the process's log
 * until OBS-001 — and `e2e/setup/stack.ts` parses it. A failed release is counted in it
 * and named on its own `console.error` line by the sweeper; the exit code is non-zero only
 * when the pass itself could not run, because a cron tick that failed one row of a
 * thousand should still be read as "ran".
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(composeAppModule(env), {
    logger: ['error', 'warn'],
  });
  const database = app.get<TenantDatabase>(TENANT_DATABASE);
  try {
    const sweeper = app.get<UploadSessionSweeper>(UPLOAD_SESSION_SWEEPER);
    const report = await sweeper.sweep();
    console.warn(`[sweeper] pass: ${describeSweep(report)}`);
  } finally {
    await app.close();
    // `app.close()` tears the injector down and leaves the pool open — the HTTP process
    // never needs it closed, and a pool with idle connections keeps the event loop alive.
    // A job has to let the process end, the way the relay ends its own pool. The first
    // E2E-12b run found this: the sweep reported and then never exited.
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error('[sweeper] fatal', error);
  process.exitCode = 1;
});
