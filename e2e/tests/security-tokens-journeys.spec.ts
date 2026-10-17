import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * Personal access tokens (MCP) on the Security screen — the whole life of a token through a
 * real browser against the real stack: a member creates one, is shown the plaintext **once**,
 * sees it listed afterwards by its prefix hint alone, and revokes it.
 *
 * These are the acceptance checks of module 20's Security screen and 0202's token contract:
 *
 * - **See once.** The plaintext is in the success panel immediately after creation and nowhere
 *   else — a reload clears it, and the full secret never reaches the list, which carries only
 *   the `tmanage_pat_xxxxxx…` hint.
 * - **It is a real credential.** The plaintext shown in the UI authenticates the TManage MCP
 *   server's Bearer path; revoking it on the screen stops it at the next request.
 * - **Revoke is visible and final.** The revoked row loses its Revoke control and reads
 *   "Revoked"; a member who created nothing sees the empty state.
 *
 * Tokens persist in the one shared seed database across these serial journeys, so each token is
 * named uniquely and every assertion is scoped to its own row — never a count of all rows.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: { readonly owner: SeededUser; readonly designer: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The seed's Northstar tenant slug — the db suites hardcode the same value; the e2e world omits it. */
const NORTHSTAR_SLUG = 'northstar-studio';

/** `tmanage_pat_` + 43 base64url characters — the exact shape the server mints and shows once. */
const TOKEN_PATTERN = /^tmanage_pat_[A-Za-z0-9_-]{43}$/;

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

async function openSecurity(page: Page): Promise<void> {
  await page.goto(`/${NORTHSTAR_SLUG}/settings/security`);
  await expect(page.getByRole('heading', { name: 'Create a token' })).toBeVisible();
}

/** Create a token through the form and return the plaintext the success panel shows once. */
async function createToken(page: Page, name: string, expiresInDays?: number): Promise<string> {
  await page.getByLabel('Name').fill(name);
  if (expiresInDays !== undefined) {
    await page.getByLabel('Expires in (days, optional)').fill(String(expiresInDays));
  }
  await page.getByRole('button', { name: 'Create token' }).click();

  const secret = page.getByTestId('tm-pat-secret');
  await expect(secret).toBeVisible();
  const token = (await secret.textContent())?.trim() ?? '';
  expect(token).toMatch(TOKEN_PATTERN);
  return token;
}

/** The member's own row for a token, found by its unique name. */
function tokenRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name });
}

test.describe('the Security personal-access-token journeys', () => {
  test('a member who has created no tokens sees the empty state', async ({ browser }) => {
    const context = await browser.newContext();
    // The Northstar designer is a member of this tenant but is never given a token by these
    // journeys, so the empty state is honest and independent of test ordering.
    await signIn(context, world().northstar.designer.id);
    const page = await context.newPage();
    await openSecurity(page);

    await expect(page.getByText('You have no personal access tokens yet.')).toBeVisible();
    await expect(page.getByTestId('tm-pat-secret')).toHaveCount(0);

    await context.close();
  });

  test('creating a token shows the plaintext exactly once and lists it by its prefix only', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();
    await openSecurity(page);

    const name = `See-once ${Date.now()}`;
    const token = await createToken(page, name);

    // The success panel says it in words, and the plaintext is right there.
    await expect(page.getByText('This is the only time the token is shown.')).toBeVisible();

    // The row appears, carrying the hint — the prefix plus six characters and an ellipsis — and
    // never the full secret. "never used" and "no expiry" are the fresh token's own facts.
    const row = tokenRow(page, name);
    await expect(row).toBeVisible();
    const prefix = `${token.slice(0, 'tmanage_pat_'.length + 6)}…`;
    await expect(row.getByText(prefix)).toBeVisible();
    await expect(row.getByText(/no expiry/)).toBeVisible();
    await expect(row.getByText(/never used/)).toBeVisible();
    await expect(row.getByText(token, { exact: true })).toHaveCount(0);

    // See once: a reload clears the only place the plaintext ever was.
    await page.reload();
    await expect(tokenRow(page, name)).toBeVisible();
    await expect(page.getByTestId('tm-pat-secret')).toHaveCount(0);
    await expect(page.getByText(token, { exact: true })).toHaveCount(0);

    await context.close();
  });

  test('a token created with an expiry records it on the row', async ({ browser }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();
    await openSecurity(page);

    const name = `Expiring ${Date.now()}`;
    await createToken(page, name, 30);

    const row = tokenRow(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByText(/expires/)).toBeVisible();
    await expect(row.getByText(/no expiry/)).toHaveCount(0);

    await context.close();
  });

  test('the created plaintext authenticates the MCP Bearer path, and revoking it stops it', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();
    await openSecurity(page);

    const name = `MCP client ${Date.now()}`;
    const token = await createToken(page, name);

    // The `request` fixture is its own context — no session cookie — so this exercises the Bearer
    // path alone, not the cookie the browser holds (the guard prefers the cookie when both exist).
    const live = await request.get(`${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/home/my-day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.status()).toBe(200);

    // Revoke on the screen.
    const row = tokenRow(page, name);
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('Revoked')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);

    // The same Bearer request is now refused — a revoked token is refused with a 401.
    const dead = await request.get(`${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/home/my-day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dead.status()).toBe(401);

    await context.close();
  });
});
