// Shutdown never interrupts a migration.
//
// Hostinger's deploy starts the app and then restarts it: on 2026-10-26 the SIGTERM of that
// restart landed 64 ms into migration 0237, the process exited at once, and the ledger row was
// left 'running' between a committed DDL statement and its counter update — 32 minutes down.
//
// The gate below sits between the boot's migration run and the signal handler:
//
//   * while a migration run is in progress, a signal only REQUESTS a stop. The migrator asks
//     `shouldStop()` before each file, so the file in progress always finishes and the next
//     one never starts;
//   * the signal handler awaits `settle()` before it exits, bounded by `graceMs` (120 s): a
//     migration that hangs cannot keep a stopping process alive forever. Past the bound the
//     process exits anyway, and the migrator's resume of a 'running' row covers the rest;
//   * once a stop is requested, boot does not continue past the migrations (`stopping`).

import { clearTimeout } from 'node:timers';

/** How long a shutdown waits for the migration file in progress, in milliseconds. */
export const MIGRATION_SHUTDOWN_GRACE_MS = 120_000;

/**
 * @param {{ graceMs?: number, log?: (message: string) => void }} [options]
 */
export function createMigrationGate({ graceMs = MIGRATION_SHUTDOWN_GRACE_MS, log } = {}) {
  let stopping = false;
  /** @type {Promise<unknown> | undefined} */
  let current;

  return {
    /** `true` once a stop has been requested. */
    get stopping() {
      return stopping;
    },

    /** `true` while a migration run is in progress. */
    get running() {
      return current !== undefined;
    },

    /**
     * Run `task(shouldStop)`, the migration run. `shouldStop` turns `true` once a stop is
     * requested; pass it to the migrator's `shouldStop` option.
     * @template T
     * @param {(shouldStop: () => boolean) => Promise<T>} task
     * @returns {Promise<T>}
     */
    async run(task) {
      const promise = Promise.resolve().then(() => task(() => stopping));
      current = promise;
      try {
        return await promise;
      } finally {
        current = undefined;
      }
    },

    /** Ask the run in progress (and any later one) to stop after its current file. */
    requestStop() {
      stopping = true;
    },

    /**
     * Wait for the run in progress, if any: 'idle' when there was none, 'finished' or
     * 'failed' when it ended, 'timed-out' after `graceMs`. Never rejects.
     * @returns {Promise<'idle' | 'finished' | 'failed' | 'timed-out'>}
     */
    async settle() {
      const promise = current;
      if (promise === undefined) return 'idle';
      log?.(
        `waiting for the migration in progress to finish its current file (up to ${Math.round(graceMs / 1000)} s)`,
      );
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const timeout = new Promise((done) => {
        timer = setTimeout(() => done('timed-out'), graceMs);
      });
      try {
        const outcome = await Promise.race([
          promise.then(
            () => 'finished',
            () => 'failed',
          ),
          timeout,
        ]);
        log?.(
          outcome === 'timed-out'
            ? `migration still running after ${Math.round(graceMs / 1000)} s; exiting anyway (the next start resumes it)`
            : `migration ${outcome}; continuing shutdown`,
        );
        return /** @type {'finished' | 'failed' | 'timed-out'} */ (outcome);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
