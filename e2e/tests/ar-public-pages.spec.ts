import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * E2E-53-53 and VR-53-54 (53 §53-20 audit debt, release gate line 3) — the Arabic public pages, in
 * a real browser against the real stack, with no session.
 *
 * For every page below (each one a twin listed in `PUBLIC_LOCALIZED_PATHS`):
 *
 * - the document is `dir="rtl"` and `lang="ar"`;
 * - **no English fallback**: no English value of a catalog key the page's own components use (and
 *   the website chrome's) appears in the rendered text, when its Arabic value differs;
 * - **Latin-led lines are marked** (the 55-13 rule, as the catalogs apply it): a text line that
 *   mixes Arabic with a Latin brand token from the glossary and starts with the Latin token starts
 *   with U+200F, so it lays out right to left;
 * - axe-core finds 0 critical or serious WCAG A/AA violations (the `a11y-audit.spec.ts` method).
 *
 * VR-53-54: six `toHaveScreenshot` baselines in this spec's snapshot folder — desktop and phone for
 * the top of `/ar`, `/ar/pricing` and `/ar/security` — plus the site footer of `/ar` on each device
 * (the six are viewport shots and never reach it). Not the Storybook VR suite.
 * Re-take them only for a change that touches these pages: `playwright test ar-public-pages -u`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const WEB_SRC = resolve(REPO_ROOT, 'apps/web/src');
const AXE_SOURCE = readFileSync(
  createRequire(resolve(REPO_ROOT, 'apps/web/package.json')).resolve('axe-core/axe.min.js'),
  'utf8',
);
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

const EN = JSON.parse(
  readFileSync(resolve(WEB_SRC, 'lib/i18n/messages/en.json'), 'utf8'),
) as Record<string, string>;
const AR = JSON.parse(
  readFileSync(resolve(WEB_SRC, 'lib/i18n/messages/ar.json'), 'utf8'),
) as Record<string, string>;
const BRANDS = (
  JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/domain/src/i18n/glossary.json'), 'utf8'),
  ) as {
    brands: string[];
  }
).brands;

/** The website chrome every public page renders (nav, mega menu, footer). */
const CHROME = [
  'components/website/WebNav.tsx',
  'components/website/MegaMenu.tsx',
  'components/website/WebFooter.tsx',
  'components/website/site-nav.ts',
];

interface ArabicPage {
  readonly path: string;
  /** Source files and folders (under `apps/web/src`) whose catalog keys the page renders. */
  readonly sources: readonly string[];
  /** VR-53-54: the pages with desktop and phone baselines. */
  readonly baseline?: string;
}

const PAGES: readonly ArabicPage[] = [
  { path: '/ar', sources: ['components/website/pages/home'], baseline: 'ar-home' },
  { path: '/ar/pricing', sources: ['components/website/pages/pricing'], baseline: 'ar-pricing' },
  { path: '/ar/security', sources: ['components/website/pages/security'], baseline: 'ar-security' },
  { path: '/ar/legal/privacy', sources: ['components/screens/MarketingLegalScreen.tsx'] },
  { path: '/ar/legal/terms', sources: ['components/screens/MarketingLegalScreen.tsx'] },
  { path: '/ar/integrations', sources: ['components/website/pages/integrations'] },
  { path: '/ar/security/data-location', sources: ['components/website/pages/data-location'] },
  { path: '/ar/download', sources: ['components/website/pages/download'] },
];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

function filesUnder(path: string): string[] {
  const absolute = resolve(WEB_SRC, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute)
    .filter((name) => /\.(ts|tsx)$/u.test(name) && !/\.(test|stories)\./u.test(name))
    .map((name) => join(absolute, name));
}

/** Every catalog key written literally in the page's sources and the chrome. */
function keysUsedBy(page: ArabicPage): string[] {
  const keys = new Set<string>();
  for (const file of [...page.sources, ...CHROME].flatMap(filesUnder)) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /['"`]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"`]/gu,
    )) {
      const key = match[1] ?? '';
      if (key in EN) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The English phrases that would betray a fallback: the longest literal run of each used key's
 * English value (placeholders split it), when the Arabic value differs and the run is a phrase of
 * at least two Latin words — a lone brand or product word is legitimately Latin in Arabic too.
 */
function englishTells(page: ArabicPage): string[] {
  const tells = new Set<string>();
  for (const key of keysUsedBy(page)) {
    const en = EN[key] ?? '';
    if (en === AR[key]) continue;
    const run = en
      .split(/\{[^}]*\}/u)
      .map((part) => part.trim())
      .sort((a, b) => b.length - a.length)[0];
    if (run !== undefined && run.length >= 10 && (run.match(/[A-Za-z]{2,}/gu) ?? []).length >= 2) {
      tells.add(run);
    }
  }
  return [...tells];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

async function auditSeriousAndCritical(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const results = (await page.evaluate(async (tags) => {
    const engine = (
      window as unknown as {
        axe: { run: (context: Document, options: object) => Promise<unknown> };
      }
    ).axe;
    return engine.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: [...tags] },
    });
  }, WCAG_TAGS)) as { violations: AxeViolation[] };
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.impact}/${violation.id}: ${violation.help} — ${violation.nodes
          .map((node) => node.target.join(' '))
          .join('; ')}`,
    );
}

/** Text lines that mix Arabic with a Latin brand, start with the Latin brand, and lack U+200F. */
async function unmarkedLatinLedLines(page: Page): Promise<string[]> {
  return page.evaluate((brands) => {
    const arabic = /[\u0600-\u06FF]/u;
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, bdi, [dir="ltr"]')) continue;
      const text = (node.textContent ?? '').replace(/^[\s\u00A0]+/u, '');
      if (!arabic.test(text) || text.startsWith('\u200F') || text.startsWith('\u061C')) continue;
      if (brands.some((brand) => text.startsWith(brand))) out.push(text.slice(0, 80));
    }
    return out;
  }, BRANDS);
}

/**
 * The installer checksum `/download` reads is written at deploy time and served by the one-process
 * server, never by Next.js (`installer-checksum.ts`). The stack runs `next dev` alone, where that
 * request falls through to a dev 404 whose rebuild keeps the network from going idle; answer it
 * the way the deployed server does, so the page renders its checksum block as it does live.
 */
async function serveInstallerChecksum(page: Page): Promise<void> {
  await page.route('**/downloads/TManage-Setup.exe.sha256', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${'0123456789abcdef'.repeat(4)}  TManage-Setup.exe\n`,
    }),
  );
}

/** The page has rendered (client components hydrated) once its heading is visible and idle. */
async function open(page: Page, path: string): Promise<void> {
  await serveInstallerChecksum(page);
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), path).toBe(200);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
}

test.describe('Arabic public pages — right to left, no English fallback, accessible', () => {
  for (const arabicPage of PAGES) {
    test(`${arabicPage.path} reads in Arabic, right to left`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
      try {
        const page = await context.newPage();
        await open(page, arabicPage.path);

        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.locator('html')).toHaveAttribute('lang', /^ar\b/u);

        const tells = englishTells(arabicPage);
        expect(tells.length, `${arabicPage.path}: catalog keys found`).toBeGreaterThan(0);
        const rendered = await page.locator('body').innerText();
        expect(
          tells.filter((tell) => rendered.includes(tell)),
          `${arabicPage.path}: English fallback`,
        ).toEqual([]);

        expect(await unmarkedLatinLedLines(page), `${arabicPage.path}: U+200F`).toEqual([]);
        expect(await auditSeriousAndCritical(page), `${arabicPage.path}: axe`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  for (const arabicPage of PAGES.filter((candidate) => candidate.baseline !== undefined)) {
    for (const [device, viewport] of Object.entries(VIEWPORTS)) {
      test(`VR-53-54 ${arabicPage.path} on ${device}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        try {
          const page = await context.newPage();
          await open(page, arabicPage.path);
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`${arabicPage.baseline}-${device}.png`, {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.02,
          });
        } finally {
          await context.close();
        }
      });
    }
  }

  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    test(`VR-53-54 /ar footer on ${device}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await open(page, '/ar');
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('footer.tm-web-footer')).toHaveScreenshot(
          `ar-home-footer-${device}.png`,
          { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 },
        );
      } finally {
        await context.close();
      }
    });
  }
});
