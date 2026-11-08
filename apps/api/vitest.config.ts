import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately separated.
 *
 * `unit` is fast and runs on every save. `database` starts a real MariaDB 11.8 server
 * (ADR-0002) and is slower, so it runs as its own gate — but it is never optional. On
 * MariaDB the tenant guarantee lives in application-layer controls rather than in the
 * engine (ADR-0001), so this suite is the only thing that demonstrates it.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // R50 L1 (2026-11-08): unit files run in parallel worker threads. The old root-level
          // `fileParallelism: false` (meant for `database`) ran all ~650 unit files one by
          // one, and import time, not test time, was the whole cost. Threads start faster
          // than forks on Windows; each file keeps its own module graph (isolate stays on).
          pool: 'threads',
          // With every core busy, first-call lazy loads (the HTML sanitiser, the XML parser,
          // proof-of-work hashing) missed vitest's 5 s default while passing alone. The
          // ceiling, not any assertion, is what moved.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'database',
          environment: 'node',
          include: ['test/**/*.db.test.ts'],
          // One private MariaDB 11.8 server per file (scripts/db/mariadb-server.mjs); against
          // TMANAGE_TEST_DATABASE_URL, parallel files would race on the same database. Scoped to
          // this project so the unit files are not serialised with it.
          fileParallelism: false,
          // A real server has to start (the first run also extracts the MariaDB runtime
          // into .local/mariadb), initialise, migrate, and seed before the first assertion.
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
