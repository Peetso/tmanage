import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page, Response } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * NFR B2, the Arabic journey (audit 2026-10-25, gap 1): one person switches the site to Arabic
 * and walks sign-in → home → a work item → chat → a client request, and on every screen the
 * document reads right-to-left, the screen's own labels are Arabic, and nothing of the English
 * catalogue is left on it.
 *
 * - **AR-01** — the switch is the website footer's "English · العربية", the one a signed-out
 *   person actually has; every later screen is reached with the choice it saved, never `?lang=`.
 *
 * "No English leftovers" is checked mechanically, not by a list of strings that would rot: every
 * visible text node and every `aria-label`/`placeholder`/`title`/`alt` on the screen is read, and
 * three things are taken out before any Latin word may remain —
 *
 *   1. **data**: every string the API sent this page (collected off the page's own responses)
 *      and every string of the seed world — a project called "Atlas Website Relaunch" is a
 *      name, not a leftover;
 *   2. **the Arabic catalogue's own Latin words** (`ar.json`: "TManage", "Google", "CSV"…) — the
 *      translators kept them on purpose;
 *   3. anything inside an element that declares a non-Arabic `lang` (the switch's "English").
 *
 * Whatever Latin word is still standing came from the bundle in English: a leftover.
 */

const ORG = 'northstar-studio';

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemTitle: string;
  };
  readonly atlas: {
    readonly admin: SeededUser;
  };
}

function rawWorld(): unknown {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as unknown;
}

function world(): World {
  return rawWorld() as World;
}

/** Every string anywhere inside a JSON value. */
function stringsIn(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') {
    if (/[A-Za-z]/.test(value)) into.add(value.trim());
  } else if (Array.isArray(value)) {
    for (const entry of value) stringsIn(entry, into);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) stringsIn(entry, into);
  }
  return into;
}

const LATIN_WORD = /[A-Za-z][A-Za-z'’-]{2,}/g;

/**
 * The Latin words the Arabic catalogue itself uses — brand and product names, file formats, key
 * names. Only words with a capital letter: a lowercase Latin word in `ar.json` is an example
 * value (`name`, `company`), not wording a screen should be allowed to show.
 */
function catalogueLatinWords(): Set<string> {
  const catalogue = JSON.parse(
    readFileSync(new URL('../../apps/web/src/lib/i18n/messages/ar.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const words = new Set<string>();
  for (const value of stringsIn(catalogue, new Set<string>())) {
    // `{placeholders}` are filled at render time; their names are not words on screen.
    for (const word of value.replace(/\{[^}]*\}/g, ' ').match(LATIN_WORD) ?? []) {
      if (/[A-Z]/.test(word)) words.add(word);
    }
  }
  return words;
}

const ALLOWED_WORDS = catalogueLatinWords();

/**
 * Collects the JSON the API sends one page. A screen's data is whatever arrived this way, so a
 * Latin title or name that is on screen and in a response is the person's, not the catalogue's.
 */
function watchApiData(page: Page): { readonly settle: () => Promise<Set<string>> } {
  const pending: Promise<void>[] = [];
  const data = stringsIn(rawWorld(), new Set<string>());
  page.on('response', (response: Response) => {
    if (!response.url().startsWith(API_URL)) return;
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    pending.push(
      response
        .json()
        .then((body: unknown) => {
          stringsIn(body, data);
        })
        .catch(() => undefined),
    );
  });
  return {
    settle: async () => {
      await page.waitForLoadState('networkidle');
      await Promise.allSettled(pending);
      return data;
    },
  };
}

/** Every visible piece of text a person (or their screen reader) meets on the page. */
function screenTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts: string[] = [];
    const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const nonArabic = (element: Element): boolean => {
      const declared = element.closest('body [lang]');
      return declared !== null && !declared.getAttribute('lang')?.toLowerCase().startsWith('ar');
    };
    const shown = (element: Element): boolean =>
      element.checkVisibility({ checkVisibilityCSS: true });

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? '';
      if (!parent || text === '' || skipped.has(parent.tagName)) continue;
      if (nonArabic(parent) || !shown(parent)) continue;
      texts.push(text);
    }
    for (const element of Array.from(
      document.body.querySelectorAll('[aria-label], [placeholder], [title], img[alt]'),
    )) {
      if (nonArabic(element) || !shown(element)) continue;
      for (const name of ['aria-label', 'placeholder', 'title', 'alt']) {
        const value = element.getAttribute(name)?.trim();
        if (value) texts.push(value);
      }
    }
    return texts;
  });
}

/** The Latin words left on the screen once data and the catalogue's own words are taken out. */
async function englishLeftovers(page: Page, data: Set<string>): Promise<string[]> {
  // Longest first, so "Atlas Website Relaunch" is removed before "Atlas" could split it.
  const known = [...data].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  const leftovers = new Set<string>();
  for (const text of await screenTexts(page)) {
    let rest = text;
    for (const value of known) {
      if (rest.includes(value)) rest = rest.split(value).join(' ');
    }
    // Addresses and links are data even when no response named them whole.
    rest = rest.replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const word of rest.match(LATIN_WORD) ?? []) {
      if (!ALLOWED_WORDS.has(word)) leftovers.add(`${word}  ←  "${text.slice(0, 80)}"`);
    }
  }
  return [...leftovers];
}

/** One screen, read in Arabic: right-to-left, an Arabic `lang`, Arabic chrome, no English left. */
async function expectArabicScreen(
  page: Page,
  screen: string,
  watch: { readonly settle: () => Promise<Set<string>> },
  chrome: Locator,
): Promise<void> {
  const html = page.locator('html');
  await expect(html, `${screen}: dir`).toHaveAttribute('dir', 'rtl');
  await expect(html, `${screen}: lang`).toHaveAttribute('lang', /^ar/);
  // Hydration paints the English server snapshot first; read the screen once its own chrome
  // (the heading, or the shell's navigation where the heading is a seeded English title) is Arabic.
  await expect(chrome, `${screen}: Arabic labels`).toContainText(/[؀-ۿ]/u);
  const data = await watch.settle();
  expect(await englishLeftovers(page, data), `${screen}: English left on screen`).toEqual([]);
}

/** The CSRF headers a direct API call from this signed-in context must carry. */
async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const csrf = (await context.cookies(API_URL)).find(
    (cookie) => cookie.name === 'tmanage_session_csrf',
  )?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf as string, origin: WEB_URL };
}

/** A client's request, filed through the portal API in its own (English) context. */
async function clientFilesRequest(browser: Browser, title: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const session = await context.request.post(`${API_URL}/v1/dev/sessions`, {
      data: { userId: world().atlas.admin.id },
    });
    expect(session.ok()).toBe(true);
    const response = await context.request.post(
      `${API_URL}/v1/organizations/${ORG}/portal/requests`,
      {
        headers: await csrfHeaders(context),
        data: {
          projectId: world().northstar.projectId,
          title,
          description: 'نحتاج قائمة الخدمات الجديدة على الموقع قبل نهاية الشهر.',
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  } finally {
    await context.close();
  }
}

const REQUEST_TITLE = 'تحديث قائمة الخدمات على الموقع';
const CHANNEL_NAME = `قناة-الإطلاق-${Date.now()}`;
const MESSAGE = 'سنراجع التصميم مع العميل يوم الخميس.';

test.describe('the Arabic journey', () => {
  test('AR-01: a person switches to Arabic and walks sign-in, home, work, chat and a request in it', async ({
    browser,
  }) => {
    await clientFilesRequest(browser, REQUEST_TITLE);

    const context = await browser.newContext();
    try {
      const page = await context.newPage();

      // The switch: the website footer's "العربية". The page mirrors without a reload.
      await page.goto('/');
      await page
        .locator('.tm-web-footer__lang--desktop')
        .getByRole('button', { name: 'العربية' })
        .click();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      // Sign-in, in Arabic, through the screen.
      let watch = watchApiData(page);
      await page.goto('/sign-in');
      await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
      await expectArabicScreen(page, 'sign-in', watch, page.locator('h1').first());
      const disclosure = page.getByText('دخول للتطوير — بدون تحقق من الهوية');
      await expect(disclosure).toBeVisible();
      if (!(await page.getByLabel('معرّف المستخدم').isVisible())) await disclosure.click();
      await expect(page.getByLabel('معرّف المستخدم')).toBeEnabled();
      await page.getByLabel('معرّف المستخدم').fill(world().northstar.owner.id);
      watch = watchApiData(page);
      await page.getByRole('button', { name: 'بدء جلسة تطوير' }).click();

      // Home: from the picker when the person has more than one workspace, else straight there.
      await expect(page).toHaveURL(/\/(organizations|northstar-studio\/home)$/);
      if (/\/organizations$/.test(page.url())) {
        await page.locator(`a[href^="/${ORG}/"]`).first().click();
        await expect(page).toHaveURL(new RegExp(`/${ORG}/`));
      }
      if (!/\/northstar-studio\/home$/.test(page.url())) {
        watch = watchApiData(page);
        await page.goto(`/${ORG}/home`);
      }
      const nav = page.getByRole('navigation').first();
      await expectArabicScreen(page, 'home', watch, nav);

      // A work item.
      watch = watchApiData(page);
      await page.goto(`/${ORG}/work/${world().northstar.workItemId}`);
      await expect(
        page.getByRole('heading', { name: world().northstar.workItemTitle }).first(),
      ).toBeVisible();
      await expectArabicScreen(page, 'work item', watch, nav);

      // Chat: a channel and a message, made as this person, read on the chat screen.
      const headers = await csrfHeaders(context);
      const base = `${API_URL}/v1/organizations/${ORG}`;
      const channel = await context.request.post(`${base}/conversations`, {
        headers,
        data: { projectId: world().northstar.projectId, name: CHANNEL_NAME },
      });
      expect(channel.ok(), await channel.text()).toBe(true);
      const conversationId = ((await channel.json()) as { id: string }).id;
      const posted = await context.request.post(
        `${base}/conversations/${conversationId}/messages`,
        { headers, data: { body: MESSAGE } },
      );
      expect(posted.ok(), await posted.text()).toBe(true);
      watch = watchApiData(page);
      await page.goto(`/${ORG}/chat/${conversationId}`);
      await expect(page.getByText(MESSAGE)).toBeVisible();
      await expectArabicScreen(page, 'chat', watch, nav);

      // A client request, opened from the studio's request list.
      watch = watchApiData(page);
      await page.goto(`/${ORG}/work/requests`);
      await page.getByRole('link', { name: REQUEST_TITLE }).first().click();
      await expect(page.getByRole('heading', { name: REQUEST_TITLE }).first()).toBeVisible();
      await expectArabicScreen(page, 'request', watch, nav);
    } finally {
      await context.close();
    }
  });
});

/** The Arabic catalogue, read the way the existing check reads it (`ar.json`). */
function arabicMessage(key: string): string {
  const catalogue = JSON.parse(
    readFileSync(new URL('../../apps/web/src/lib/i18n/messages/ar.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const value = catalogue[key];
  expect(value, `ar.json has ${key}`).toBeTruthy();
  return value as string;
}

/** The Arabic public pages this journey reads, with the tab title each prerenders. */
const ARABIC_PUBLIC_PAGES = [
  { path: '/ar', title: arabicMessage('HomePage.pageTitle') },
  { path: '/ar/pricing', title: `${arabicMessage('WebsiteTitle.pricing')} · TManage` },
] as const;

/** Same-origin link targets on the page (path + query, no hash), each once. */
async function internalLinks(page: Page): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'), (anchor) => anchor.getAttribute('href') ?? ''),
  );
  const targets = new Set<string>();
  for (const href of hrefs) {
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const target = href.split('#')[0] ?? '';
    if (target !== '') targets.add(target);
  }
  return [...targets].sort();
}

test.describe('the Arabic public pages', () => {
  test('AR-02: /ar and /ar/pricing arrive in Arabic, their links resolve, and the switch goes to English and back', async ({
    browser,
  }) => {
    // A cold dev server compiles every linked route on first request.
    test.setTimeout(300_000);
    // A fresh visitor: no saved language, an English browser — the path alone names Arabic.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const checked = new Set<string>();

      for (const { path, title } of ARABIC_PUBLIC_PAGES) {
        const response = await page.goto(path);
        expect(response?.status(), `${path}: status`).toBe(200);
        const html = page.locator('html');
        await expect(html, `${path}: lang`).toHaveAttribute('lang', /^ar/);
        await expect(html, `${path}: dir`).toHaveAttribute('dir', 'rtl');
        await expect(page, `${path}: Arabic title`).toHaveTitle(title);
        await expect(page.locator('h1').first(), `${path}: Arabic heading`).toContainText(/[؀-ۿ]/u);

        const links = await internalLinks(page);
        expect(links.length, `${path}: has links`).toBeGreaterThan(0);
        // An Arabic page links to the Arabic twin of a public page, never its English copy.
        expect(links, `${path}: links to its Arabic twins`).not.toContain('/pricing');
        expect(links, `${path}: links to the Arabic pricing page`).toContain('/ar/pricing');
        // The contact orb ("راسل TManage") stays in Arabic, and articles now have Arabic pages
        // too, so an article is linked at /ar/resources/…, never its English copy. Every link,
        // the Arabic articles included, must resolve (checked below).
        expect(links, `${path}: links to the Arabic contact page`).toContain('/ar/contact');
        expect(links, `${path}: no English contact link`).not.toContain('/contact');
        expect(
          links.filter((link) => link.startsWith('/resources/')),
          `${path}: no English article links`,
        ).toEqual([]);
        for (const link of links) {
          if (checked.has(link)) continue;
          checked.add(link);
          const target = await context.request.get(link, { maxRedirects: 5 });
          expect(target.status(), `${path} → ${link}: resolves`).toBeLessThan(400);
        }
      }

      // The switch: "English" leaves /ar/pricing for /pricing, which reads left-to-right.
      const footerSwitch = page.locator('.tm-web-footer__lang--desktop');
      await footerSwitch.getByRole('button', { name: 'English' }).click();
      await expect(page).toHaveURL(/\/pricing$/);
      expect(new URL(page.url()).pathname).toBe('/pricing');
      await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page).toHaveTitle('Pricing · TManage');

      // …and "العربية" brings the same page back in Arabic.
      await footerSwitch.getByRole('button', { name: 'العربية' }).click();
      await expect(page).toHaveURL(/\/ar\/pricing$/);
      await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page).toHaveTitle(ARABIC_PUBLIC_PAGES[1].title);
    } finally {
      await context.close();
    }
  });
});
