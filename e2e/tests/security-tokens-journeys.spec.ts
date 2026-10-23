import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * Personal access tokens (MCP) on the Access tokens screen — the whole life of a token through a
 * real browser against the real stack: a member opens the "New token" dialog, creates one, is
 * shown the plaintext **once**, sees it listed afterwards by its name alone, and revokes it.
 *
 * These are the acceptance checks of module 20's Security screen (P6 4378fd36: one Access tokens
 * page, the create form in a dialog, every token expires) and 0202's token contract:
 *
 * - **See once.** The plaintext is in the success dialog immediately after creation and nowhere
 *   else — closing the dialog or reloading clears it, and the full secret never reaches the list,
 *   neither the rendered rows nor the list endpoint's JSON.
 * - **It is a real credential.** The plaintext shown in the UI authenticates the TManage MCP
 *   server's Bearer path; revoking it on the screen stops it at the next request.
 * - **Revoke asks first and is final.** Revoke opens a confirmation; once confirmed the token
 *   leaves the list and the Bearer path refuses it. A member who created nothing sees the empty
 *   state.
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

const TOKENS_PATH = `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/me/personal-access-tokens`;

const DAY_MS = 24 * 60 * 60 * 1000;

interface ListedToken {
  readonly name: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

async function openSecurity(page: Page): Promise<void> {
  await page.goto(`/${NORTHSTAR_SLUG}/settings/security`);
  await expect(page.getByRole('button', { name: 'New token', exact: true })).toBeVisible();
}

/**
 * Open the "New token" dialog, create a token through it and return the plaintext the success
 * dialog shows once. The dialog is left open on the secret; the caller closes it with "Done".
 */
async function createToken(
  page: Page,
  name: string,
  expiresInDays?: 30 | 90 | 365,
): Promise<string> {
  await page.getByRole('button', { name: 'New token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New token' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  if (expiresInDays !== undefined) {
    await dialog.getByLabel(`${expiresInDays} days`, { exact: true }).check();
  }
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();

  const secret = page.getByTestId('tm-token-secret');
  await expect(secret).toBeVisible();
  const token = (await secret.textContent())?.trim() ?? '';
  expect(token).toMatch(TOKEN_PATTERN);
  return token;
}

/** Close the success dialog; the plaintext goes with it. */
async function closeSecret(page: Page): Promise<void> {
  await page
    .getByRole('dialog', { name: 'Copy your token now' })
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(page.getByTestId('tm-token-secret')).toHaveCount(0);
}

/** The member's own row for a token, found by its unique name. */
function tokenRow(page: Page, name: string) {
  return page.getByTestId('tm-token-row').filter({ hasText: name });
}

/** The list endpoint as the signed-in browser sees it: raw text and the parsed tokens. */
async function listTokens(
  context: BrowserContext,
): Promise<{ text: string; tokens: readonly ListedToken[] }> {
  const response = await context.request.get(TOKENS_PATH);
  expect(response.status()).toBe(200);
  const text = await response.text();
  return { text, tokens: (JSON.parse(text) as { tokens: readonly ListedToken[] }).tokens };
}

test.describe('the Security personal-access-token journeys', () => {
  test('a member who has created no tokens sees the empty state', async ({ browser }) => {
    const context = await browser.newContext();
    // The Northstar designer is a member of this tenant but is never given a token by these
    // journeys, so the empty state is honest and independent of test ordering.
    await signIn(context, world().northstar.designer.id);
    const page = await context.newPage();
    await openSecurity(page);

    await expect(page.getByText('You have no tokens yet.')).toBeVisible();
    await expect(page.getByTestId('tm-token-row')).toHaveCount(0);
    await expect(page.getByTestId('tm-token-secret')).toHaveCount(0);

    await context.close();
  });

  test('creating a token shows the plaintext exactly once and never lists the secret', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();
    await openSecurity(page);

    const name = `See-once ${Date.now()}`;
    const token = await createToken(page, name);
    const secretPart = token.slice('tmanage_pat_'.length);

    // The success dialog says it in words, and the plaintext is right there.
    await expect(page.getByText(/This is the only time it is shown\./)).toBeVisible();

    // Closing the dialog takes the plaintext with it.
    await closeSecret(page);
    await expect(page.getByText(token, { exact: true })).toHaveCount(0);

    // The row appears by its name, active, with an expiry (every token expires) and no use yet —
    // and never the secret, whole or in part.
    const row = tokenRow(page, name);
    await expect(row).toBeVisible();
    // The status capsule carries an aria-hidden glyph beside its label, so match by substring.
    await expect(row.getByText('Active')).toBeVisible();
    await expect(row.getByText(/expires/)).toBeVisible();
    await expect(row.getByText(/used/)).toHaveCount(0);
    await expect(row).not.toContainText(token);
    await expect(row).not.toContainText(secretPart);

    // The list endpoint carries the row and never the plaintext.
    const listed = await listTokens(context);
    expect(listed.tokens.some((t) => t.name === name)).toBe(true);
    expect(listed.text).not.toContain(token);
    expect(listed.text).not.toContain(secretPart);

    // See once: a reload clears the only place the plaintext ever was.
    await page.reload();
    await expect(tokenRow(page, name)).toBeVisible();
    await expect(page.getByTestId('tm-token-secret')).toHaveCount(0);
    await expect(page.getByText(token, { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(secretPart);

    await context.close();
  });

  test('a token created with an expiry records it on the row', async ({ browser }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();
    await openSecurity(page);

    const name = `Expiring ${Date.now()}`;
    const before = Date.now();
    await createToken(page, name, 30);
    await closeSecret(page);

    const row = tokenRow(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByText(/expires/)).toBeVisible();

    // The chosen 30 days, not the 90-day default, is what the server stored.
    const listed = (await listTokens(context)).tokens.find((t) => t.name === name);
    expect(listed?.expiresAt).toBeTruthy();
    const days = (new Date(listed?.expiresAt as string).getTime() - before) / DAY_MS;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

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
    await closeSecret(page);

    // The `request` fixture is its own context — no session cookie — so this exercises the Bearer
    // path alone, not the cookie the browser holds (the guard prefers the cookie when both exist).
    const live = await request.get(`${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/home/my-day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.status()).toBe(200);

    // Revoke on the screen: the row's Revoke asks first, the dialog's Revoke does it.
    const row = tokenRow(page, name);
    await row.getByRole('button', { name: `Revoke ${name}`, exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke this token?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    // A revoked token leaves the list, and stays gone after a reload.
    await expect(tokenRow(page, name)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'New token', exact: true })).toBeVisible();
    await expect(tokenRow(page, name)).toHaveCount(0);

    // The same Bearer request is now refused — a revoked token is refused with a 401.
    const dead = await request.get(`${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/home/my-day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dead.status()).toBe(401);

    await context.close();
  });
});
