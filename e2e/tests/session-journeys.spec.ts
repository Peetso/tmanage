import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The session's life in a real browser against the real stack — the acceptance checks of
 * review findings D01, D02 and D04 (2026-09-05), as journeys.
 *
 * - **D01 — signing out leaves nothing of the previous person behind.** Person A has the
 *   organization list cached in one tab; a second tab signs out. The first tab, without a
 *   reload, is sent to sign-in, and when person B signs in there — through the screen, a
 *   client-side navigation, the same `QueryClient` — B sees B's organizations and never A's,
 *   even with B's list held back on the wire long enough for a stale cache to have shown.
 * - **D02 — the documented defaults work in a browser.** The stack no longer tells the web app
 *   the cookie name (`e2e/setup/stack.ts`). The sign-out below is a `DELETE` the browser
 *   sends with a CSRF token it read from the cookie under the *default* name; before this
 *   change that request carried no token and was refused.
 * - **D04 — an expired access token is not the end of the session.** The access cookie is
 *   removed from the jar (what expiry does, fifteen minutes sooner); the next page load and
 *   the next mutation both succeed, the refresh cookie is seen to rotate, and once the session
 *   is genuinely revoked the next mutation ends at sign-in rather than at an error.
 *
 * The dev sign-in route is used for the *first* session of each context, as every journey
 * does; B's sign-in in the D01 journey goes through the screen because the point is what the
 * screen does on the way.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: { readonly owner: SeededUser };
  readonly brightops: { readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const ACCESS_COOKIE = 'tmanage_session';
const REFRESH_COOKIE = 'tmanage_session_refresh';
const CSRF_COOKIE = 'tmanage_session_csrf';

const NORTHSTAR = 'Northstar Studio';
const BRIGHTOPS = 'BrightOps Consulting';

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

/**
 * The whole jar, not `context.cookies(API_URL)`: Playwright filters by the URL's *path* as
 * well as its host, and the refresh cookie is scoped to `/v1/sessions/refresh`, so a lookup
 * by the origin alone never lists it.
 */
async function cookie(context: BrowserContext, name: string): Promise<string | undefined> {
  return (await context.cookies()).find((c) => c.name === name)?.value;
}

/** Playwright ≥ 1.43 clears by name; the other cookies of the jar are untouched. */
async function dropCookie(context: BrowserContext, name: string): Promise<void> {
  await context.clearCookies({ name });
  expect(await cookie(context, name)).toBeUndefined();
}

async function signInThroughTheScreen(page: Page, userId: string): Promise<void> {
  await page.getByLabel('User id').fill(userId);
  await page.getByRole('button', { name: 'Start a development session' }).click();
}

test.describe('the session journeys', () => {
  test('D01: a sign-out in one tab clears every tab, and the next person sees only their own organizations', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);

    // Tab 1: A's organization list, cached in this tab's QueryClient.
    const first = await context.newPage();
    await first.goto('/organizations');
    await expect(first.getByText(NORTHSTAR)).toBeVisible();

    // Tab 2: A signs out. The browser sends the CSRF token it found under the default cookie
    // name (D02) — the API answers 204 only if it did.
    const second = await context.newPage();
    await second.goto('/sessions');
    await second.getByRole('button', { name: 'Sign out of this session' }).click();
    await expect(second).toHaveURL(/\/sign-in$/);
    expect(await cookie(context, ACCESS_COOKIE)).toBeUndefined();
    expect(await cookie(context, REFRESH_COOKIE)).toBeUndefined();

    // Tab 1 heard it: no reload, no click — it is at sign-in.
    await expect(first).toHaveURL(/\/sign-in$/);

    // B's organization list is held back on the wire. A stale cache would have had three
    // seconds to show A's rows; the screen must show none.
    await first.route(`${API_URL}/v1/organizations`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    await signInThroughTheScreen(first, world().brightops.owner.id);
    await expect(first).toHaveURL(/\/organizations$/);
    // Immediately, and while the response is still held: nothing of A.
    await expect(first.getByText(NORTHSTAR)).toHaveCount(0);
    await first.waitForTimeout(1_500);
    await expect(first.getByText(NORTHSTAR)).toHaveCount(0);

    // Then B's own.
    await expect(first.getByText(BRIGHTOPS)).toBeVisible({ timeout: 15_000 });
    await expect(first.getByText(NORTHSTAR)).toHaveCount(0);

    // Back does not resurrect A either: the sign-in screen, then B's list again from B's
    // session — never A's rows.
    await first.goBack();
    await expect(first).toHaveURL(/\/sign-in$/);
    await first.goForward();
    await expect(first).toHaveURL(/\/organizations$/);
    await expect(first.getByText(BRIGHTOPS)).toBeVisible({ timeout: 15_000 });
    await expect(first.getByText(NORTHSTAR)).toHaveCount(0);

    await context.close();
  });

  test('D04: an expired access token is refreshed on the next read and the next mutation, and a revoked session ends at sign-in', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const refreshBefore = await cookie(context, REFRESH_COOKIE);
    expect(refreshBefore).toBeTruthy();

    // A tab that was open when the access token expired.
    const sessions = await context.newPage();
    await sessions.goto('/sessions');
    await expect(sessions.getByText('Where you are signed in')).toBeVisible();

    // Expiry, fifteen minutes early: the access cookie goes, the refresh cookie stays.
    await dropCookie(context, ACCESS_COOKIE);

    // Idle return — a fresh page load whose first read is refused, refreshed, and replayed.
    const organizations = await context.newPage();
    await organizations.goto('/organizations');
    await expect(organizations.getByText(NORTHSTAR)).toBeVisible();

    const refreshAfterRead = await cookie(context, REFRESH_COOKIE);
    expect(refreshAfterRead).toBeTruthy();
    expect(refreshAfterRead).not.toBe(refreshBefore);
    expect(await cookie(context, ACCESS_COOKIE)).toBeTruthy();
    expect(await cookie(context, CSRF_COOKIE)).toBeTruthy();

    // Expiry before a mutation: the sign-out in the old tab is refused, refreshed, replayed —
    // and succeeds, which is visible as the navigation to sign-in with the jar emptied.
    await dropCookie(context, ACCESS_COOKIE);
    await sessions.getByRole('button', { name: 'Sign out of this session' }).click();
    await expect(sessions).toHaveURL(/\/sign-in$/);
    expect(await cookie(context, ACCESS_COOKIE)).toBeUndefined();
    expect(await cookie(context, REFRESH_COOKIE)).toBeUndefined();
    await expect(sessions.getByText('Sign-out failed')).toHaveCount(0);

    // The other tab heard the sign-out and went to sign-in without a reload.
    await expect(organizations).toHaveURL(/\/sign-in$/);

    await context.close();
  });

  test('D04: when the refresh itself is refused, the tab ends at sign-in rather than at an error', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().brightops.owner.id);

    const sessions = await context.newPage();
    await sessions.goto('/sessions');
    await expect(sessions.getByText('Where you are signed in')).toBeVisible();

    // The session is revoked behind the tab's back — from the API, as an administrator or
    // another device would. The API's response clears this jar's cookies as well.
    const csrf = await cookie(context, CSRF_COOKIE);
    expect(csrf).toBeTruthy();
    const revoked = await context.request.delete(`${API_URL}/v1/sessions/current`, {
      headers: { 'x-csrf-token': csrf as string },
    });
    expect(revoked.status()).toBe(204);
    expect(await cookie(context, REFRESH_COOKIE)).toBeUndefined();

    // The tab's next mutation: 401, a refresh that is refused, and the clean end.
    await sessions.getByRole('button', { name: 'Sign out of this session' }).click();
    await expect(sessions).toHaveURL(/\/sign-in$/);

    await context.close();
  });
});
