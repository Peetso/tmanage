import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-02 — the platform admin team (D5) through a real browser against the real
 * stack.
 *
 * `world().platformAdmin` is on `PLATFORM_ADMIN_EMAILS` (`e2e/setup/stack.ts`), so they are the
 * bootstrap super admin: their row is locked. They add `world().supportCandidate` with the Support
 * preset (reason required), who can then open `/platform` but meets the 403 state on `/platform/team`
 * (no `platform.team.manage`). Disabling them, again with a reason, takes the whole Platform admin
 * away: `GET /v1/platform/me` answers 404 as for anyone else.
 *
 * Fresh stack per run, one worker, serial: the journey writes the team table and does not restore it.
 */

interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly supportCandidate: PlatformUser;
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  const page = await context.newPage();
  return { context, page };
}

/** The Platform admin step-up: password only (neither seeded account has a two-step factor). */
async function stepUp(page: Page, password: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('platform-step-up-pill')).toContainText('Step-up valid');
}

test.describe.serial('the platform admin team journeys', () => {
  test('E2E-PA02-01: the bootstrap super admin sees their own row locked', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().platformAdmin.id);
    await page.goto('/platform/team');
    await stepUp(page, world().platformAdmin.password);

    const table = page.getByRole('table', { name: 'Platform admins' });
    const own = table.getByRole('row').filter({ hasText: world().platformAdmin.email });
    await expect(own).toContainText('Server list');
    await expect(own).toContainText('Locked');
    await expect(own).toContainText('Your own row is read-only');
    await expect(own.getByRole('button')).toHaveCount(0);
    await context.close();
  });

  test('E2E-PA02-02: a super admin adds a Support admin with a reason', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().platformAdmin.id);
    await page.goto('/platform/team');
    await stepUp(page, world().platformAdmin.password);

    await page.getByRole('button', { name: 'Add platform admin' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Verified TManage account').fill(world().supportCandidate.email);
    await dialog.getByRole('radio', { name: 'Support' }).click();
    // "Manage this team" only comes with the Super admin preset.
    await expect(dialog.getByLabel('Manage this team')).toBeDisabled();
    // Without a reason the dialog refuses.
    await dialog.getByRole('button', { name: 'Add admin' }).click();
    await expect(dialog.getByText('A reason is required (5–500 characters).')).toBeVisible();
    await dialog.getByLabel('Reason (required)').fill('Joining the support rota from 1 Nov');
    await dialog.getByRole('button', { name: 'Add admin' }).click();
    await expect(dialog).toHaveCount(0);

    const added = page
      .getByRole('table', { name: 'Platform admins' })
      .getByRole('row')
      .filter({ hasText: world().supportCandidate.email });
    await expect(added).toContainText('Added here');
    await expect(added).toContainText('Support');
    await expect(added).toContainText('Active');
    await context.close();
  });

  test('E2E-PA02-03: the Support admin opens /platform but not the team page', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, world().supportCandidate.id);
    await page.goto('/platform');
    await stepUp(page, world().supportCandidate.password);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.goto('/platform/team');
    await expect(page.getByText("Your platform permissions don't include this")).toBeVisible();
    await expect(page.getByText('platform.team.manage')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add platform admin' })).toHaveCount(0);
    await context.close();
  });

  test('E2E-PA02-04: disabling with a reason takes Platform admin away (404)', async ({
    browser,
  }) => {
    const admin = await openAs(browser, world().platformAdmin.id);
    await admin.page.goto('/platform/team');
    await stepUp(admin.page, world().platformAdmin.password);

    const target = admin.page
      .getByRole('table', { name: 'Platform admins' })
      .getByRole('row')
      .filter({ hasText: world().supportCandidate.email });
    await target.getByRole('button', { name: 'Disable' }).click();
    const dialog = admin.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Disable admin' }).click();
    await expect(dialog.getByText('A reason is required (5–500 characters).')).toBeVisible();
    await dialog.getByLabel('Reason (required)').fill('Left the support rota');
    await dialog.getByRole('button', { name: 'Disable admin' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(target).toContainText('Disabled');
    await expect(target.getByRole('button', { name: 'Enable' })).toBeVisible();
    await admin.context.close();

    const former = await openAs(browser, world().supportCandidate.id);
    const me = await former.context.request.get(`${API_URL}/v1/platform/me`);
    expect(me.status()).toBe(404);
    await former.context.close();
  });
});
