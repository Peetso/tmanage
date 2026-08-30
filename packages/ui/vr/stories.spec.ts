import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Every story, screenshotted, compared against a committed baseline.
 *
 * The story list comes from `storybook-static/index.json` at collection time rather than
 * from a list written here — a story added to `stories/` is in the harness the next run,
 * and a story that stops building fails the `index.json` read instead of silently leaving
 * a stale baseline behind. `pnpm test:vr` builds Storybook first for the same reason: a
 * screenshot of last week's bundle would be a test of nothing.
 *
 * Three variants per story:
 *
 * - **light** and **dark** — the two themes every primitive must survive; the jsdom suite
 *   proves their token wiring, this proves their paint.
 * - **rtl** — Arabic direction over the light theme. The jsdom suite asserts logical
 *   properties; until this harness existed, RTL had never actually been *rendered* on this
 *   machine (recorded as a WEB-001 gap). High contrast stays with the arithmetic checks:
 *   33 contrast cases already compute what a screenshot could only eyeball.
 *
 * The shot is the `#storybook-root` element, not the page: the page is mostly decorator
 * padding, and an element shot keeps each PNG as small as the component it certifies.
 */

interface StoryIndexEntry {
  readonly id: string;
  readonly type: string;
}

const indexPath = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'storybook-static',
  'index.json',
);

const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entries: Record<string, StoryIndexEntry>;
};

const stories = Object.values(index.entries)
  .filter((entry) => entry.type === 'story')
  .map((entry) => entry.id)
  .sort();

const VARIANTS = [
  { name: 'light', globals: 'theme:light;direction:ltr' },
  { name: 'dark', globals: 'theme:dark;direction:ltr' },
  { name: 'rtl', globals: 'theme:light;direction:rtl' },
] as const;

test('the story index is not empty', () => {
  // Guards the loop below: an empty index would generate zero tests and report green.
  expect(stories.length).toBeGreaterThan(0);
});

for (const id of stories) {
  for (const variant of VARIANTS) {
    test(`${id} · ${variant.name}`, async ({ page }) => {
      await page.goto(
        `/iframe.html?viewMode=story&id=${encodeURIComponent(id)}&globals=${encodeURIComponent(
          variant.globals,
        )}`,
      );
      const root = page.locator('#storybook-root');
      // Rendered means "has children", not "exists": the root div is in the static HTML
      // before React mounts anything into it.
      await expect(root.locator(':scope > *').first()).toBeVisible();
      // The packaged font must have painted; the fallback face has different metrics and
      // would diff every text node against a baseline shot after the swap.
      await page.evaluate(() => document.fonts.ready);
      await expect(root).toHaveScreenshot(`${id}--${variant.name}.png`);
    });
  }
}
