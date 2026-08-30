import { defineConfig, devices } from '@playwright/test';

/**
 * UI-001's visual-regression harness — configuration, and the decisions it encodes.
 *
 * **The baselines are committed PNGs**, one per story per variant, living beside the spec
 * in its `-snapshots/` directory. The alternatives were weighed in
 * `docs/implementation-status.md` and rejected there: a digest-only baseline cannot show a
 * human what changed, and an uncommitted baseline is not a baseline — it is whatever the
 * last run happened to produce.
 *
 * **The baselines are this machine's.** Font rasterisation and antialiasing differ across
 * OS and GPU, so a PNG rendered elsewhere would diff everywhere while nothing had changed.
 * There is no CI here (recorded elsewhere: Actions is dead), so the honest scope is "the
 * machine the suite runs on", and Playwright's default snapshot naming keeps the platform
 * suffix in the filename to say so.
 *
 * **Determinism levers**, each doing one job: a fixed viewport and DPR so layout width
 * cannot drift; `reducedMotion` plus `animations: 'disabled'` so nothing is caught
 * mid-transition; `caret: 'hide'` so a blinking cursor in a focused field cannot flake;
 * and the spec waits on `document.fonts.ready` so the packaged face has painted before the
 * shot — the fallback face has different metrics and would diff every text node.
 */
export default defineConfig({
  testDir: '.',
  // One worker: 84 element screenshots are fast anyway, and parallel Chromium contexts
  // fighting for GPU raster time is a flake source with zero upside here.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:6007',
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    // `reducedMotion` is a context option, not a test option, hence the nesting.
    contextOptions: { reducedMotion: 'reduce' },
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
    },
  },
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:6007/iframe.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
