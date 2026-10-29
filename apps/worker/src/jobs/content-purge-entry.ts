import type { WorkerDatabase } from '../common/database/worker-database.js';
// Registers the organization purge in PURGE_HOOKS (side-effect import, as in main.ts).
import './purge-organizations.js';
import { PURGE_HOOKS, runPurge } from './purge-sweeper.js';
import type { PurgeReport } from './purge-sweeper.js';

/** One `--sweep-purge` pass with every registered hook — what the CLI runs, for the in-process scheduler. */
export function runContentPurge(database: WorkerDatabase): Promise<PurgeReport> {
  return runPurge(database, PURGE_HOOKS);
}
