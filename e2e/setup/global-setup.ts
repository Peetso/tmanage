import { bootStack } from './stack.js';

/**
 * Boots the whole stack once for the run and hands Playwright a teardown. The seed world
 * crosses into the workers as an environment variable — the documented Playwright pattern
 * for run-scoped facts — so every spec reads the same ids the database suites read.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await bootStack();
  process.env['TMANAGE_E2E_WORLD'] = JSON.stringify(stack.world);
  // For `drainOutbox`: a journey that needs the worker to have run names the same database.
  process.env['TMANAGE_E2E_DATABASE_URL'] = stack.databaseUrl;
  // FILE-001b: the upload journey checks that the bytes landed, on disk, once.
  process.env['TMANAGE_E2E_STORAGE_ROOT'] = stack.storageRoot;
  return stack.stop;
}
