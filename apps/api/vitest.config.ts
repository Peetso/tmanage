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
    // One private MariaDB 11.8 server per file (scripts/db/mariadb-server.mjs); against
    // TMANAGE_TEST_DATABASE_URL, parallel files would race on the same database. `fileParallelism` is a root-level option, so it applies to `unit` too —
    // an acceptable cost given how few unit files there are.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'database',
          environment: 'node',
          include: ['test/**/*.db.test.ts'],
          // A real server has to start (the first run also extracts the MariaDB runtime
          // into .local/mariadb), initialise, migrate, and seed before the first assertion.
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
