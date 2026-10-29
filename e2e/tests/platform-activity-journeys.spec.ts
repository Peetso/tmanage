import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-09 — Activity & access (C1–C6) through a real browser against the real
 * stack.
 *
 * The operator (`world().platformAdmin`, the bootstrap super admin) opens the action log and the
 * tabs, follows the old `/platform/audit` link to Platform admins, ends one live session of
 * BrightOps' owner with a reason (that session's next request is refused, the operator's own keeps
 * working), and runs a sign-ins export — written by the API at once — then downloads it.
 *
 * The export is left in place (it expires on its own); nothing else is changed. Fresh stack per
 * run, one worker, serial.
 */

interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly brightops: { readonly organizationId: string; readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page; csrf: string }> {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const page = await context.newPage();
  return { context, page, csrf: csrfToken };
}

/** The Platform admin step-up: password only (the seeded platform account has no factor). */
async function stepUp(page: Page, password: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('platform-step-up-pill')).toContainText('Step-up valid');
}

async function openAdmin(browser: Browser, path: string) {
  const admin = await openAs(browser, world().platformAdmin.id);
  await admin.page.goto(path);
  await stepUp(admin.page, world().platformAdmin.password);
  return admin;
}

test.describe.serial('the platform activity journeys', () => {
  test('E2E-PA09-01: the action log, the tabs, and the old audit link', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/activity');
    await expect(page.getByRole('heading', { level: 1, name: 'Actions' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Activity sections' });
    for (const name of ['Actions', 'Access', 'Platform admins', 'Exports']) {
      await expect(tabs.getByRole('link', { name: new RegExp(`^${name}`, 'u') })).toBeVisible();
    }
    await expect(page.getByText(/\d[\d,]* actions · /u)).toBeVisible();

    await page.goto('/platform/audit');
    await expect(page).toHaveURL(/\/platform\/activity\/platform$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'Platform admins' })).toBeVisible();
    await context.close();
  });

  test('E2E-PA09-02: end one live session with a reason', async ({ browser }) => {
    const owner = world().brightops.owner;
    const target = await openAs(browser, owner.id);
    const before = await target.context.request.get(`${API_URL}/v1/sessions/current/devices`);
    expect(before.ok()).toBe(true);

    const { context, page } = await openAdmin(browser, '/platform/activity/access');
    await page.getByRole('button', { name: 'Live sessions' }).click();
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill(owner.email);
    const table = page.getByRole('table', { name: 'Live sessions' });
    await expect(table.getByText(owner.email).first()).toBeVisible();
    // The row of the owner's session, not the first row: until the search lands the table still
    // lists every live session, the admin's own first.
    await table
      .getByRole('row')
      .filter({ hasText: owner.email })
      .getByRole('button', { name: 'End session' })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'End session' }).click();
    await expect(dialog.getByText(/reason/iu).first()).toBeVisible();
    await dialog.getByLabel(/^Reason \(required/u).fill('E2E — lost laptop');
    await dialog.getByRole('button', { name: 'End session' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Session ended for ${owner.email}`)).toBeVisible();

    const after = await target.context.request.get(`${API_URL}/v1/sessions/current/devices`);
    expect(after.status()).toBe(401);
    await target.context.close();
    await context.close();
  });

  test('E2E-PA09-03: a sign-ins export is ready at once and downloads as CSV', async ({
    browser,
  }) => {
    const { context, page } = await openAdmin(browser, '/platform/activity/exports');
    await page.getByRole('combobox', { name: 'New export' }).selectOption('sign-ins');
    await page.getByRole('button', { name: 'Run export' }).click();
    const table = page.getByRole('table', { name: 'Exports' });
    const row = table.getByRole('row', { name: /Sign-ins/u }).first();
    await expect(row.getByText(/^Ready/u)).toBeVisible();
    const href = await row.getByRole('link', { name: 'Download' }).getAttribute('href');
    expect(href).toMatch(/\/v1\/platform\/activity\/exports\/[0-9a-f-]+\/download$/u);
    const response = await context.request.get(href as string);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    const csv = await response.text();
    expect(csv.split('\r\n')[0]).toMatch(/^occurredAt,email,/u);
    await context.close();
  });
});
