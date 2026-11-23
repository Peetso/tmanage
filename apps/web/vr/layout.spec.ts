import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  DENSITY_V2,
  countByRule,
  measureLayout,
  type LayoutRule,
  type LayoutViolation,
} from './layout-invariants';
import { settleStory } from './settle';

/**
 * The layout invariants of Density v2 (ADR-0016, UX-26…UX-28), measured in the built Storybook.
 *
 * 1. **The proof.** The fixture story `checks-layout-invariants` draws the shell and My Day's
 *    plain capsule with the real stylesheets. `BeforeFix` re-applies the two declarations commit
 *    `7ce92a65` removed (content 8px from the rail; capsule text 12px from the rounded end). The
 *    check must report both there and nothing on `Fixed`. If the checker ever stops seeing the
 *    owner's two defects, this fails.
 * 2. **The ratchet.** Every `vr`-tagged screen story, in light LTR and in RTL, is measured and its
 *    violations are counted per rule. `docs/architecture/baselines/layout-invariants.json` holds
 *    the counts; a story may not exceed them, and a story not in the file must have none. Run with
 *    `LAYOUT_BASELINE=update` to lower the file to today's counts (it refuses to raise one: README
 *    §4, raising a baseline needs an ADR).
 */

interface StoryIndexEntry {
  readonly id: string;
  readonly type: string;
  readonly tags?: readonly string[];
}

const indexPath = join(__dirname, '..', 'storybook-static', 'index.json');
// `LAYOUT_BASELINE_FILE` points a measuring run elsewhere (a report of another build); the
// ratchet itself always reads the committed file.
const baselinePath =
  process.env['LAYOUT_BASELINE_FILE'] ??
  join(__dirname, '..', '..', '..', 'docs', 'architecture', 'baselines', 'layout-invariants.json');

const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entries: Record<string, StoryIndexEntry>;
};

const screens = Object.values(index.entries)
  .filter((entry) => entry.type === 'story' && (entry.tags ?? []).includes('vr'))
  .sort((a, b) => a.id.localeCompare(b.id));

const VARIANTS = [
  { name: 'light', globals: 'theme:light;direction:ltr' },
  { name: 'rtl', globals: 'theme:light;direction:rtl' },
] as const;

type Counts = Partial<Record<LayoutRule, number>>;

async function measureStory(
  page: Page,
  id: string,
  globals: string,
  awaitsPlay: boolean,
): Promise<LayoutViolation[]> {
  await page.goto(
    `/iframe.html?viewMode=story&id=${encodeURIComponent(id)}&globals=${encodeURIComponent(globals)}`,
  );
  await expect(page.locator('#storybook-root > *').first()).toBeAttached({ timeout: 20_000 });
  await settleStory(page, { awaitsPlay });
  return page.evaluate(measureLayout, { ...DENSITY_V2, root: '#storybook-root' });
}

test.describe('the check sees the owner-reported defects (fixture)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('BeforeFix: content 8px from the rail and capsule text 12px from its end are reported', async ({
    page,
  }) => {
    const found = await measureStory(
      page,
      'checks-layout-invariants--before-fix',
      'theme:light;direction:ltr',
      false,
    );
    const gutter = found.find((v) => v.rule === 'gutter');
    const capsule = found.find((v) => v.rule === 'capsule-inset');
    expect(gutter, JSON.stringify(found)).toBeDefined();
    expect(gutter?.measured).toBe(8);
    expect(capsule, JSON.stringify(found)).toBeDefined();
    expect(capsule?.measured).toBe(12);
  });

  test('Fixed: the same screen with today’s CSS has no violation', async ({ page }) => {
    for (const globals of ['theme:light;direction:ltr', 'theme:light;direction:rtl']) {
      const found = await measureStory(page, 'checks-layout-invariants--fixed', globals, false);
      expect(found, `${globals}: ${JSON.stringify(found)}`).toEqual([]);
    }
  });
});

test('every vr screen story stays within its layout baseline', async ({ browser, baseURL }) => {
  test.setTimeout(30 * 60_000);
  expect(screens.length).toBeGreaterThan(0);

  const current: Record<string, Counts> = {};
  const detail: Record<string, LayoutViolation[]> = {};
  const broken: string[] = [];
  for (const entry of screens) {
    const awaitsPlay = (entry.tags ?? []).includes('vr-play');
    for (const variant of VARIANTS) {
      // A fresh context per story, as the screenshot spec has (one test per story there): a play
      // story's stored state, its ready flag and a resized viewport must not leak into the next.
      const context = await browser.newContext({
        ...(baseURL ? { baseURL } : {}),
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const key = `${entry.id} · ${variant.name}`;
      let found: LayoutViolation[];
      try {
        found = await measureStory(page, entry.id, variant.globals, awaitsPlay);
      } catch (error) {
        await context.close();
        // A story that no longer renders is a broken check, unless this is a report of an old
        // build (`LAYOUT_BASELINE_FILE` set), where it is listed and skipped.
        if (!process.env['LAYOUT_BASELINE_FILE']) throw new Error(`${key}: ${String(error)}`);
        broken.push(key);
        continue;
      }
      await context.close();
      const counts = countByRule(found);
      if (Object.keys(counts).length > 0) current[key] = counts;
      detail[key] = found;
    }
  }

  const baseline: Record<string, Counts> = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { stories: Record<string, Counts> })
        .stories
    : {};

  const grown: string[] = [];
  for (const [key, counts] of Object.entries(current)) {
    for (const [rule, n] of Object.entries(counts) as [LayoutRule, number][]) {
      const allowed = baseline[key]?.[rule] ?? 0;
      if (n > allowed) {
        const examples = (detail[key] ?? [])
          .filter((v) => v.rule === rule)
          .slice(0, 5)
          .map((v) => `${v.where} ${v.measured}<${v.required}`)
          .join('; ');
        grown.push(`${key}: ${rule} ${n} > ${allowed} (${examples})`);
      }
    }
  }

  // `LAYOUT_DETAIL_FILE=<path>` writes every violation with its element, for the lane that fixes
  // them; the ratchet itself only needs the counts.
  const detailFile = process.env['LAYOUT_DETAIL_FILE'];
  if (detailFile)
    writeFileSync(
      detailFile,
      `${JSON.stringify(detail, null, 1)}
`,
    );

  if (process.env['LAYOUT_BASELINE'] === 'update') {
    expect(existsSync(baselinePath) ? grown : [], 'refusing to raise the layout baseline').toEqual(
      [],
    );
    const stories = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
    );
    const total = Object.values(stories).reduce(
      (sum, c) => sum + Object.values(c).reduce((a, b) => a + (b ?? 0), 0),
      0,
    );
    writeFileSync(
      baselinePath,
      `${JSON.stringify(
        {
          $comment:
            'Layout-invariant violations per vr story and rule (apps/web/vr/layout.spec.ts, ADR-0016). May only shrink.',
          total,
          ...(broken.length > 0 ? { notMeasured: broken } : {}),
          stories,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  expect(grown, grown.join('\n')).toEqual([]);
});
