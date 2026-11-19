import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Every `[vr]`-tagged story, screenshotted, compared against a committed baseline — the twin of
 * `packages/ui/vr/stories.spec.ts`, reading the same `index.json` and driving the same three
 * variants. Two things differ, because these are whole screens and not primitives:
 *
 * - **The story set is tagged, not swept.** `packages/ui` shoots every story in its Storybook
 *   because every one is a primitive that must survive the matrix. `apps/web`'s Storybook also
 *   holds the developers' view of every screen, most of which no one asked to baseline, so this
 *   harness shoots only the stories that carry the `vr` tag. A screen joins the harness by adding
 *   the tag to its story; `index.json` carries the tags, so the opt-in needs nothing here.
 *
 * - **The shot waits for the screen to settle, not just to mount.** A primitive paints in one
 *   frame; a screen fetches through React Query, flips a `LoadingRegion` to content, and a couple
 *   of them only reach their target state after a scripted interaction (`play`). So before each
 *   shot this spec waits, in order: the root has children, the packaged font has painted, any
 *   `vr-play` story has signalled it is ready, every loading region has cleared, and the DOM has
 *   stopped mutating. Without that, two runs of the same story would race each other and the
 *   suite would be the flake it is meant to catch.
 */

interface StoryIndexEntry {
  readonly id: string;
  readonly type: string;
  readonly tags?: readonly string[];
}

// `__dirname` (this file is loaded as CommonJS — see `run.mjs` for why the harness stays CJS) is
// `apps/web/vr`; the built Storybook sits one level up beside it.
const indexPath = join(__dirname, '..', 'storybook-static', 'index.json');

const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entries: Record<string, StoryIndexEntry>;
};

const stories = Object.values(index.entries)
  .filter((entry) => entry.type === 'story' && (entry.tags ?? []).includes('vr'))
  .sort((a, b) => a.id.localeCompare(b.id));

const VARIANTS = [
  { name: 'light', globals: 'theme:light;direction:ltr' },
  { name: 'dark', globals: 'theme:dark;direction:ltr' },
  { name: 'rtl', globals: 'theme:light;direction:rtl' },
] as const;

test('the tagged story set is not empty', () => {
  // Guards the loop below: an empty set would generate zero tests and report green, which is the
  // exact failure a visual-regression suite exists to not have.
  expect(stories.length).toBeGreaterThan(0);
});

for (const entry of stories) {
  const id = entry.id;
  const awaitsPlay = (entry.tags ?? []).includes('vr-play');
  // A `vr-fullpage` story paints into a fixed-position layer (a toast region pinned to a viewport
  // corner, outside `#storybook-root`'s box), so its baseline is the whole viewport, not the root
  // element — the element shot would be empty.
  const fullPage = (entry.tags ?? []).includes('vr-fullpage');

  for (const variant of VARIANTS) {
    test(`${id} · ${variant.name}`, async ({ page }) => {
      await page.goto(
        `/iframe.html?viewMode=story&id=${encodeURIComponent(id)}&globals=${encodeURIComponent(
          variant.globals,
        )}`,
      );

      const root = page.locator('#storybook-root');
      // Mounted means "has children", not "exists": the root div is in the static HTML before
      // React mounts anything into it. `toBeAttached`, not `toBeVisible` — a screen whose only
      // content is a fixed-position layer leaves the root box zero-sized, which is "hidden" to
      // Playwright but is exactly the state a `vr-fullpage` story shoots.
      await expect(root.locator(':scope > *').first()).toBeAttached();

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

      if (fullPage) {
        await expect(page).toHaveScreenshot(`${id}--${variant.name}.png`);
      } else {
        await expect(root).toHaveScreenshot(`${id}--${variant.name}.png`);
      }
    });
  }
}
