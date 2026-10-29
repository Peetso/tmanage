import { defineConfig } from '@playwright/test';

/**
 * 51-06 — the RT-LIVE journeys against a deployed site, with no local stack.
 *
 * The default config boots MariaDB, the API and the web app in its global setup; a live run must
 * not, so this config has none and runs only `realtime-live-journeys.spec.ts`. The site is
 * `E2E_BASE_URL`; the two signed-in test accounts and the channel come from the env the spec
 * documents (`docs/runbooks/realtime-live-proof.md`).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'realtime-live-journeys.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'],
    trace: 'on',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
});
