import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The phone shell (audit 2026-10-25b, gap 8 — "23 Mobile proof"): one member, on a 375px phone,
 * gets around the product with nothing but the dock — the tab bar's four destinations, the
 * "More" sheet and the lime quick-capture orb — once in English and once in Arabic.
 *
 * - **PH-01** — the tab bar: the desktop rail is gone, the dock fits the screen, and each of My
 *   Day, Inbox, Chat and Work is a real link that lands on its screen and is then the one marked
 *   `aria-current="page"`.
 * - **PH-02** — the More sheet: a modal dialog that takes focus on "Done", keeps Tab inside it,
 *   closes on Escape (focus back on "More"), on "Done" and on the scrim, and whose tiles navigate
 *   and close it.
 * - **PH-03** — the FAB: a tap opens Quick capture with its title field ready.
 *
 * Arabic is chosen the way a shared link chooses it (`?lang=ar` on the first screen, persisted by
 * the boot script); every later screen is reached by tapping the dock, so the choice has to hold.
 * The words asserted are read from the two message catalogues rather than copied here, so a
 * re-worded label never makes this journey lie — and in Arabic the dock must also mirror: the
 * quick-capture orb sits on the left of the pill, not the right.
 */

const ORG = 'northstar-studio';
const PHONE = { width: 375, height: 812 } as const;

type Lang = 'en' | 'ar';

interface World {
  readonly northstar: {
    readonly owner: { readonly id: string };
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

function catalogue(lang: Lang): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../apps/web/src/lib/i18n/messages/${lang}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

const CATALOGUES: Readonly<Record<Lang, Record<string, unknown>>> = {
  en: catalogue('en'),
  ar: catalogue('ar'),
};

/** The catalogue's word for `key` (flat or dotted-nested), failing loudly when it is missing. */
function word(lang: Lang, key: string): string {
  const messages = CATALOGUES[lang];
  const flat = messages[key];
  const nested = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages,
    );
  const value = typeof flat === 'string' ? flat : nested;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${lang}.json has no message for "${key}"`);
  }
  return value;
}

/** A phone context signed in through the dev session route — a real session, not a mock. */
async function phoneAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  return { context, page: await context.newPage() };
}

interface Dock {
  readonly bar: Locator;
  readonly destination: (key: string) => Locator;
  readonly more: Locator;
  readonly fab: Locator;
}

function dock(page: Page, lang: Lang): Dock {
  const bar = page.getByRole('navigation', { name: word(lang, 'shell.rail.mobilePrimary') });
  return {
    bar,
    destination: (key) => bar.getByRole('link', { name: word(lang, key), exact: true }),
    more: bar.getByRole('button', { name: word(lang, 'shell.mobile.more'), exact: true }),
    fab: page.getByRole('link', { name: word(lang, 'shell.mobile.capture'), exact: true }),
  };
}

/** The screen is in `lang`, hydrated (the shell's own words are in it), and the dock is drawn. */
async function expectPhoneScreen(page: Page, lang: Lang, phone: Dock): Promise<void> {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  await expect(html).toHaveAttribute('lang', lang === 'ar' ? /^ar/ : /^en/);
  await expect(phone.bar).toBeVisible();
  // Hydration paints the English server snapshot first; read the dock once it says its own word.
  await expect(phone.destination('nav.home')).toBeVisible();
  await expect(phone.fab).toBeVisible();
  // One navigation at a time: the desktop rail is hidden at the dock's breakpoint. Exact, because
  // the dock's own label ("Primary mobile") contains the rail's ("Primary").
  await expect(
    page.getByRole('navigation', { name: word(lang, 'shell.rail.primary'), exact: true }),
  ).toBeHidden();
}

const DESTINATIONS = [
  { key: 'nav.home', path: '/home' },
  { key: 'nav.inbox', path: '/inbox' },
  { key: 'nav.chat', path: '/chat' },
  { key: 'nav.work', path: '/work' },
] as const;

for (const lang of ['en', 'ar'] as const) {
  test.describe(`the phone shell [${lang}]`, () => {
    test(`PH-01..03 [${lang}]: tab bar, More sheet and quick capture carry a member around at 375px`, async ({
      browser,
    }) => {
      const { context, page } = await phoneAs(browser, world().northstar.owner.id);
      try {
        const phone = dock(page, lang);
        await page.goto(`/${ORG}/home${lang === 'ar' ? '?lang=ar' : ''}`);
        await expectPhoneScreen(page, lang, phone);

        // The dock fits the phone, and mirrors in Arabic: the capture orb is on the trailing side.
        const bar = await phone.bar.boundingBox();
        const fab = await phone.fab.boundingBox();
        expect(bar).not.toBeNull();
        expect(fab).not.toBeNull();
        if (bar && fab) {
          for (const box of [bar, fab]) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
          }
          if (lang === 'ar') expect(fab.x + fab.width).toBeLessThanOrEqual(bar.x);
          else expect(fab.x).toBeGreaterThanOrEqual(bar.x + bar.width);
        }

        // PH-01 — each tab lands on its screen and becomes the current one; the others do not.
        for (const target of DESTINATIONS) {
          await phone.destination(target.key).click();
          await expect(page).toHaveURL(new RegExp(`/${ORG}${target.path}(\\?.*)?$`));
          await expectPhoneScreen(page, lang, phone);
          await expect(phone.destination(target.key)).toHaveAttribute('aria-current', 'page');
          for (const other of DESTINATIONS.filter((entry) => entry.key !== target.key)) {
            await expect(phone.destination(other.key)).not.toHaveAttribute('aria-current', 'page');
          }
        }

        // PH-02 — More opens a modal sheet with focus on Done.
        const sheet = page.getByRole('dialog', { name: word(lang, 'MoreSheet.title') });
        const done = sheet.getByRole('button', { name: word(lang, 'MoreSheet.done'), exact: true });
        await expect(phone.more).toHaveAttribute('aria-expanded', 'false');
        await phone.more.tap();
        await expect(sheet).toBeVisible();
        await expect(phone.more).toHaveAttribute('aria-expanded', 'true');
        await expect(sheet).toHaveAttribute('aria-modal', 'true');
        await expect(done).toBeFocused();
        // While the sheet is open, More is the inked orb — no tab claims to be the current page.
        await expect(phone.destination('nav.work')).not.toHaveAttribute('aria-current', 'page');
        await expect(sheet).toContainText(word(lang, 'MoreSheet.workspace'));
        await expect(sheet).toContainText(word(lang, 'MoreSheet.tools'));

        // Focus stays inside: Shift+Tab from Done wraps to the last tile (Help), Tab back to Done.
        await page.keyboard.press('Shift+Tab');
        await expect(
          sheet.getByRole('link', { name: word(lang, 'MoreSheet.help'), exact: true }),
        ).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(done).toBeFocused();

        // Escape closes it and gives focus back to More.
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(phone.more).toHaveAttribute('aria-expanded', 'false');
        await expect(phone.more).toBeFocused();
        await expect(phone.destination('nav.work')).toHaveAttribute('aria-current', 'page');

        // Done closes it; so does a tap on the dimmed screen above the sheet.
        await phone.more.click();
        await expect(sheet).toBeVisible();
        await done.click();
        await expect(sheet).toBeHidden();
        await phone.more.click();
        await expect(sheet).toBeVisible();
        await page.locator('.tm-more__scrim').click({ position: { x: PHONE.width / 2, y: 24 } });
        await expect(sheet).toBeHidden();

        // A tile is a real link: it navigates and the sheet closes behind it.
        await phone.more.click();
        await sheet
          .getByRole('link', { name: word(lang, 'MoreSheet.calendar'), exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`/${ORG}/calendar(\\?.*)?$`));
        await expect(sheet).toBeHidden();
        await expectPhoneScreen(page, lang, phone);

        // PH-03 — the lime orb opens Quick capture, title field first.
        await phone.fab.tap();
        await expect(page).toHaveURL(new RegExp(`/${ORG}/capture(\\?.*)?$`));
        await expectPhoneScreen(page, lang, phone);
        await expect(
          page.getByRole('textbox', { name: word(lang, 'QuickCaptureScreen.titleLabel') }),
        ).toBeEditable();
      } finally {
        await context.close();
      }
    });
  });
}
