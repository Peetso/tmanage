import type { Page } from '@playwright/test';

/**
 * Bring a loaded story to the state a measurement or a shot may be taken in. Shared by
 * `stories.spec.ts` (the screenshots) and `layout.spec.ts` (the layout invariants, ADR-0016), so
 * both look at the same settled screen. The steps and their reasons are unchanged from the
 * original inline version in `stories.spec.ts`.
 */
export async function settleStory(page: Page, { awaitsPlay }: { awaitsPlay: boolean }) {
  // A story that names its own viewport (`globals: { viewport: { value: 'phone' } }`, T5 D9)
  // is shot at that size, not the config's 1024 × 768. The preview's `withVrViewport`
  // decorator resolves the name and marks the document with "<width>x<height>" before the
  // story renders; the page is resized before any wait below, so the waits cover the reflow.
  const viewport = await page.evaluate(
    () => document.documentElement.dataset['vrViewport'] ?? null,
  );
  const size = viewport === null ? null : /^(\d+)x(\d+)$/u.exec(viewport);
  if (size !== null) {
    await page.setViewportSize({ width: Number(size[1]), height: Number(size[2]) });
  }

  // The packaged font must have painted; the fallback face has different metrics and would
  // diff every text node against a baseline shot after the swap.
  await page.evaluate(() => document.fonts.ready);

  // A `vr-play` story reaches its target state only after its scripted interaction finishes;
  // the play function sets this flag last, so the shot cannot land mid-interaction.
  if (awaitsPlay) {
    await page.waitForFunction(
      () => document.documentElement.dataset['vrReady'] === '1',
      undefined,
      { timeout: 10_000 },
    );
  }

  // Every React Query read has resolved: no `LoadingRegion` (`[data-loading]`) and no bare
  // skeleton is still on screen. The stub clients resolve in a microtask, but waiting on the
  // DOM rather than a timer is what keeps the two runs identical.
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '#storybook-root [data-loading="true"], #storybook-root .tm-skeleton',
      ).length === 0,
    undefined,
    { timeout: 10_000 },
  );

  // The DOM has stopped changing. Resolves after 200ms with no mutations under the root, with
  // a floor of 300ms so late effects (a resolved query, an installed fake worker) are caught,
  // and a 6s ceiling so a genuinely unstable story fails loudly instead of hanging.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const target = document.querySelector('#storybook-root');
        if (!target) {
          resolve();
          return;
        }
        const QUIET = 200;
        const FLOOR = 300;
        const CEILING = 6_000;
        const start = Date.now();
        let quietTimer = 0;
        const settle = () => {
          const wait = Math.max(QUIET, FLOOR - (Date.now() - start));
          window.clearTimeout(quietTimer);
          quietTimer = window.setTimeout(done, wait);
        };
        const done = () => {
          observer.disconnect();
          window.clearTimeout(ceilingTimer);
          resolve();
        };
        const observer = new MutationObserver(settle);
        observer.observe(target, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const ceilingTimer = window.setTimeout(done, CEILING);
        settle();
      }),
  );
}
