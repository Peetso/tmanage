import { defineConfig, devices } from '@playwright/test';

/**
 * The application-screen visual-regression harness — the twin of `packages/ui/vr`.
 *
 * `packages/ui/vr` shoots the design-system primitives; this one shoots the *screens* that
 * compose them, which `packages/ui` can never reach because `apps/web` depends on
 * `@tmanage/ui` and never the reverse. Everything load-bearing is copied deliberately from the
 * `packages/ui` config so the two harnesses behave identically and a shot means the same thing
 * in both — only three things differ, each forced by where this runs:
 *
 * 1. **Port 6009**, not 6007, so an `apps/web` run and a `packages/ui` run can both hold their
 *    static server at once (see `serve.mjs`).
 * 2. **The baselines are this machine's**, for the reason the `packages/ui` config records at
 *    length: font rasterisation and antialiasing differ across OS and GPU, there is no CI here
 *    to own a canonical renderer, so the honest scope is "the machine the suite runs on" and
 *    Playwright keeps the platform suffix in each PNG's name to say so.
 * 3. **Only `[vr]`-tagged stories are shot** (see `stories.spec.ts`): `apps/web`'s Storybook is
 *    also the developers' shop window for every screen, and baselining all ~200 of them was not
 *    asked for and would be ~600 unreviewed PNGs. A screen opts into the harness by tagging its
 *    story, exactly as a primitive opts in simply by existing under `packages/ui/stories`.
 *
 * The determinism levers are identical to the `packages/ui` config: a fixed viewport and DPR so
 * layout width cannot drift; `reducedMotion` plus `animations: 'disabled'` so nothing is caught
 * mid-transition; `caret: 'hide'` so a focused field's cursor cannot flake; and the spec waits on
 * `document.fonts.ready` (and more — see its header) before every shot.
 */
// `VR_PORT` moves the static server (and the URLs below) off 6009, so the deploy gate's run in
// its own clone never reuses a developer's server that serves another build (`serve.mjs`).
const port = Number(process.env['VR_PORT'] ?? 6009);

export default defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
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
    url: `http://127.0.0.1:${port}/iframe.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
