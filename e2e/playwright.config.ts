import { defineConfig } from '@playwright/test';
import { WEB_URL } from './setup/stack.js';

/**
 * TEST-003's runner — deliberately OUTSIDE the verification chain.
 *
 * The chain's seven gates are deterministic and finish in ~25 minutes; a full-stack boot
 * (embedded MySQL, migrations, seed, API, Next dev server, a browser) is a different kind
 * of animal, and welding it into the chain on the day it is born would put every future
 * ticket behind its worst day. It runs as `pnpm test:e2e`, alone, and earns its way into
 * anything mandatory by a track record — the judgement is recorded in
 * `docs/implementation-status.md`.
 *
 * One worker, no parallelism: one stack, one browser, journeys that share seeded state.
 * Timeouts are generous because a cold Next dev server compiles routes on first visit;
 * waits inside tests are on conditions, never tuned sleeps — the standing rule.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './setup/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // The app formats calendar dates in the *reader's* locale on purpose — `formatDay` passes
    // `undefined` to `Intl.DateTimeFormat` — so a journey that asserts "September 10, 2026"
    // is really asserting something about the browser. Pin the browser rather than pin the app:
    // under `en-GB` the same correct page reads "10 September 2026", and the failure would look
    // like a product defect on somebody else's machine. The timezone is pinned for the same
    // reason, though `formatDay` already forces UTC for `DATE` columns.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
});
