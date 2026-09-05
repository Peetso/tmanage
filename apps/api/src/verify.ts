import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@tmanage/config';
import { composeAppModule } from './app-composition.js';
import { FILE_SCANNER, FILE_VERIFIER, TENANT_DATABASE } from './common/http/tokens.js';
import type { TenantDatabase } from './common/database/tenant-context.js';
import { describeVerification } from './modules/files/file-verifier.js';
import type { FileVerifier } from './modules/files/file-verifier.js';
import { describeScan } from './modules/files/file-scanner.js';
import type { FileScanner } from './modules/files/file-scanner.js';

/**
 * FILE-002's job entry point: one verification pass over every uploaded file, then one
 * scan pass over every verified one (slice B), then exit.
 *
 * `sweep.ts`'s shape, for its reason: `50-BOOTSTRAP` §3's host cannot keep another process
 * alive, so the external tick that runs `relay:once` and `sweep:once` runs `verify:once`
 * after them (USAGE-001 decision 10, FILE-002 decision F2). The `--once` flag is accepted
 * for symmetry and is the only behaviour.
 *
 * The application is composed exactly as the HTTP process composes it
 * (`app-composition.ts`), as a context rather than a server, so the pass reads the object
 * store the uploads went into and writes through the same audit and outbox modules. One
 * report line on stderr, `[verifier] pass: …`, distinct from the sweeper's so a harness
 * parsing one never reads the other. A failed asset is counted in it and named on its own
 * `console.error` line; the exit code is non-zero only when the pass itself could not run —
 * including a store that is not wired at all, which stops the pass at its first asset.
 *
 * The scan pass runs second, in the same process, so a file verified this minute is
 * scanned this minute rather than next: the cron tick stays `relay:once`, `sweep:once`,
 * `verify:once`, with no fourth command for the Hostinger target to learn. Its line is
 * `[scanner] pass: …`. A scanner that cannot be reached at all stops that pass before it
 * claims a row and is the one way this process exits non-zero after a green verification.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(composeAppModule(env), {
    logger: ['error', 'warn'],
  });
  const database = app.get<TenantDatabase>(TENANT_DATABASE);
  try {
    const verifier = app.get<FileVerifier>(FILE_VERIFIER);
    const report = await verifier.verify();
    console.warn(`[verifier] pass: ${describeVerification(report)}`);
    const scanner = app.get<FileScanner>(FILE_SCANNER);
    const scanned = await scanner.scan();
    console.warn(`[scanner] pass: ${describeScan(scanned)}`);
  } finally {
    await app.close();
    // As in `sweep.ts`: the pool must be ended for the process to exit.
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error('[verifier] fatal', error);
  process.exitCode = 1;
});
