import { readFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from './stack.js';

/**
 * TESTE2E (2026-11-18) — the few things every bilingual journey of that pass needs, in one place
 * instead of one copy per spec: the seed world, the two message catalogues, a signed-in context
 * and the language check. The older specs keep their own copies; nothing here changes them.
 *
 * CLOSEOUT (2026-11-19): signing in and a member's saved language are `test` fixtures, so what a
 * journey changes is undone in that test's teardown — also when it fails — never left to a
 * `close()` the failure skipped.
 *
 * Words are read from the catalogues, never copied into a spec, so a re-worded label never makes
 * a journey lie, and the Arabic run asserts the Arabic words.
 */

export type Lang = 'en' | 'ar';
export const LANGS: readonly Lang[] = ['en', 'ar'];

/** The seed world `global-setup.ts` hands every worker; each spec names the slice it reads. */
export function seedWorld<T>(): T {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as T;
}

/** The run's database, for the API package's test CLIs (`stack.ts`). */
export function databaseUrl(): string {
  const url = process.env['TMANAGE_E2E_DATABASE_URL'];
  if (!url) throw new Error('TMANAGE_E2E_DATABASE_URL is not set: run through global-setup');
  return url;
}

function catalogue(lang: Lang): Readonly<Record<string, unknown>> {
  return JSON.parse(
    readFileSync(
      new URL(`../../apps/web/src/lib/i18n/messages/${lang}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

const CATALOGUES: Readonly<Record<Lang, Readonly<Record<string, unknown>>>> = {
  en: catalogue('en'),
  ar: catalogue('ar'),
};

/** The catalogue's words for `key`, `{name}` placeholders filled; fails loudly when missing. */
export function word(lang: Lang, key: string, vars: Readonly<Record<string, string>> = {}): string {
  const value = CATALOGUES[lang][key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${lang}.json has no message for "${key}"`);
  }
  return value.replace(/\{(\w+)\}/gu, (whole, name: string) => vars[name] ?? whole);
}

/** `path` as a first screen in `lang`: Arabic is chosen the way a shared link chooses it. */
export function inLang(path: string, lang: Lang): string {
  if (lang === 'en') return path;
  return `${path}${path.includes('?') ? '&' : '?'}lang=ar`;
}

/** The page reads in `lang`: `<html lang>` and its direction. */
export async function expectLanguage(page: Page, lang: Lang): Promise<void> {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  await expect(html).toHaveAttribute('lang', lang === 'ar' ? /^ar/u : /^en/u);
}

export const PHONE_390 = { width: 390, height: 844 } as const;

export interface SignedIn {
  readonly context: BrowserContext;
  readonly page: Page;
  /** For API calls the browser itself would make: cookie, this header and our origin. */
  readonly headers: Readonly<Record<string, string>>;
  /** Closes the context early; the test's teardown closes any still open. */
  readonly close: () => Promise<void>;
}

export interface SignInOptions {
  /** A touch phone: `true` is {@link PHONE_390}; a size names another phone. */
  readonly phone?: boolean | { readonly width: number; readonly height: number };
  /** Saves `lang` as the member's own language in `org` for this test (see `memberLanguage`). */
  readonly member?: { readonly org: string; readonly lang: Lang };
}

/** The seeded workspaces; coach-mark tours are dismissed on the device for each. */
const SEEDED_SLUGS = ['northstar-studio', 'northstar-studios', 'brightops-consulting'] as const;

/**
 * The device of a returning person: product tours dismissed ("Don't show tours again") and the
 * automatic-timer panel, which opens by itself once on a first home visit, already asked. A
 * tour's scrim would sit over the controls a journey is about. Call before the first page opens.
 */
export async function asReturningPerson(context: BrowserContext): Promise<void> {
  await context.addInitScript((slugs: readonly string[]) => {
    for (const slug of slugs) {
      window.localStorage.setItem(`tm-coach:${slug}:never`, 'true');
      window.localStorage.setItem(`tm.autotimer.asked.${slug}`, '1');
    }
  }, SEEDED_SLUGS);
}

const SAVED_LOCALE: Readonly<Record<Lang, string>> = { en: 'en-US', ar: 'ar-EG' };

/** The stored display settings a PUT carries (`toDisplayPreferencesUpdate` in the web app). */
const DISPLAY_FIELDS = [
  'theme',
  'density',
  'locale',
  'timezone',
  'dateFormat',
  'numerals',
  'calendarDisplay',
  'weekStart',
] as const;

/** Opens a real session for `userId` in `context`; returns the headers its API calls carry. */
async function startSession(
  context: BrowserContext,
  userId: string,
): Promise<Readonly<Record<string, string>>> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok(), await response.text()).toBe(true);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: WEB_URL };
}

/**
 * Saves `locale` as the member's own language in `org`, from a short session of their own, and
 * returns the one it replaces. A signed-in member's language is their saved preference (R25 A6,
 * `ThemeSync`), so `?lang=` does not choose it; the journey chooses it the way the member would,
 * in their display settings.
 */
async function saveMemberLocale(
  browser: Browser,
  userId: string,
  org: string,
  locale: string,
): Promise<string> {
  const context = await browser.newContext();
  try {
    const headers = await startSession(context, userId);
    const url = `${API_URL}/v1/organizations/${org}/me/display-preferences`;
    const read = await context.request.get(url);
    expect(read.ok(), await read.text()).toBe(true);
    const view = (await read.json()) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    for (const field of DISPLAY_FIELDS) if (view[field] !== undefined) body[field] = view[field];
    if (view['uiModeSource'] === 'self' && view['uiMode'] !== undefined)
      body['uiMode'] = view['uiMode'];
    const saved = await context.request.put(url, { headers, data: { ...body, locale } });
    expect(saved.ok(), await saved.text()).toBe(true);
    return view['locale'] as string;
  } finally {
    await context.close();
  }
}

export interface JourneyFixtures {
  /**
   * Saves `lang` as the member's own language in `org` for this test only. The language it
   * replaces is put back in the test's teardown, which runs when the test fails or times out
   * too, so one failed Arabic journey never leaves Arabic behind for the next spec.
   */
  readonly memberLanguage: (userId: string, org: string, lang: Lang) => Promise<void>;
  /**
   * A context signed in through the dev session route — a real session, not a mock. With
   * `member`, the member's language is set through {@link JourneyFixtures.memberLanguage}.
   * Product tours are dismissed on the device ("Don't show tours again"), as a returning person
   * has them: a tour's dialog would sit over the controls a journey is about.
   */
  readonly signIn: (userId: string, options?: SignInOptions) => Promise<SignedIn>;
}

/** The `signIn` fixture, for a spec's helper that signs someone in. */
export type SignIn = JourneyFixtures['signIn'];

/** The journeys' `test`: the fixtures above, each undone in the test's own teardown. */
export const test = base.extend<JourneyFixtures>({
  memberLanguage: async ({ browser }, use) => {
    // The language each member had before this test, kept once per member and workspace.
    const replaced = new Map<string, { userId: string; org: string; locale: string }>();
    await use(async (userId, org, lang) => {
      const locale = await saveMemberLocale(browser, userId, org, SAVED_LOCALE[lang]);
      const key = `${userId} ${org}`;
      if (!replaced.has(key)) replaced.set(key, { userId, org, locale });
    });
    const failures: unknown[] = [];
    for (const { userId, org, locale } of replaced.values()) {
      await saveMemberLocale(browser, userId, org, locale).catch((error: unknown) => {
        failures.push(error);
      });
    }
    if (failures.length > 0) throw failures[0];
  },
  signIn: async ({ browser, memberLanguage }, use) => {
    const open = new Set<BrowserContext>();
    await use(async (userId, options = {}) => {
      if (options.member) await memberLanguage(userId, options.member.org, options.member.lang);
      const phone = options.phone === true ? PHONE_390 : options.phone;
      const context = await browser.newContext(
        phone ? { viewport: phone, hasTouch: true, isMobile: true } : {},
      );
      open.add(context);
      await asReturningPerson(context);
      const headers = await startSession(context, userId);
      return {
        context,
        page: await context.newPage(),
        headers,
        close: async () => {
          open.delete(context);
          await context.close();
        },
      };
    });
    for (const context of open) await context.close();
  },
});

/** The Platform admin step-up: password only (`platform-settings-journeys.spec.ts`'s shape). */
export async function platformStepUp(page: Page, password: string): Promise<void> {
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('platform-step-up-pill')).toBeVisible();
}
