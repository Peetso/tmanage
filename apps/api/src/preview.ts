import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@tmanage/config';
import { composeAppModule } from './app-composition.js';
import { serializeForLog } from './common/observability/logger.js';
import { TENANT_DATABASE } from './common/http/tokens.js';
import type { TenantDatabase } from './common/database/tenant-context.js';
import { PREVIEW_JOB, describePreviewPass } from './modules/files/preview-job.js';
import type { PreviewJob } from './modules/files/preview-job.js';

/**
 * R4 slice 3 — `preview:once`: one preview pass (plan the ready versions that have no derivative
 * rows, then draw the pending ones), then exit. `verify.ts`'s shape: the application is composed
 * exactly as the HTTP process composes it, as a context, so the pass reads the same object store
 * and database. One report line on stderr, `[preview] pass: …`. The exit code is non-zero only
 * when the pass itself could not run (an unreachable store or database).
 *
 * On Hostinger the same pass runs in-process on a timer (`WORKER_INPROCESS=1`); this command is
 * for a local API, a one-off backfill, or an operator checking what the job would do.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(composeAppModule(env), {
    logger: ['error', 'warn'],
  });
  const database = app.get<TenantDatabase>(TENANT_DATABASE);
  try {
    const job = app.get<PreviewJob>(PREVIEW_JOB);
    const report = await job.pass();
    console.warn(`[preview] pass: ${describePreviewPass(report)}`);
  } finally {
    await app.close();
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error('[preview] fatal', serializeForLog(error));
  process.exitCode = 1;
});
