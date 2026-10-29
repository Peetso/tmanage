import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-10 — Platform settings (D1), feature flags (D2), announcements (D3) and
 * maintenance mode (D4) through a real browser against the real stack.
 *
 * `world().platformAdmin` is on `PLATFORM_ADMIN_EMAILS` (`e2e/setup/stack.ts`), so they hold every
 * platform permission. `world().supportCandidate` has a password but is not a platform admin here,
 * so they stand in for "a member" at the password sign-in the maintenance gate guards. Northstar's
 * owner is the member whose workspace shows the banner and the copilot module.
 *
 * Fresh stack per run, one worker, serial. Each journey puts back what it changed (billing mode,
 * the copilot flag, the maintenance window) so the rest of the suite runs on the seed's defaults.
 */

interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly supportCandidate: PlatformUser;
  readonly northstar: { readonly owner: { readonly id: string } };
}

const NORTHSTAR = 'northstar-studio';

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

/** The Platform admin step-up: password only. */
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

/** `datetime-local` text for now + `minutes`, in the browser's (and this machine's) time zone. */
function localInput(minutes: number): string {
  // The browser runs in UTC (playwright.config `timezoneId`), so its `datetime-local` value is
  // UTC wall time; the test runner's own zone (Cairo on this machine) must not leak in.
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);
}

/** A password sign-in from our own pages (F43: same origin), as the sign-in form sends it. */
async function passwordSignIn(browser: Browser, user: PlatformUser) {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/auth/password`, {
    headers: { origin: WEB_URL },
    data: { email: user.email, password: user.password },
  });
  const status = response.status();
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  await context.close();
  return { status, message: body.error?.message ?? '' };
}

test.describe.serial('the platform settings journeys', () => {
  test('E2E-PA10-01: billing mode goes to Paid with a reason, then back', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/settings');
    await expect(page.getByRole('heading', { name: 'Billing mode' })).toBeVisible();

    await page.getByRole('radio', { name: /^Paid/u }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Switch billing mode to Paid?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Switch to Paid' }).click();
    await expect(dialog.getByText('A reason is required (5–500 characters).')).toBeVisible();
    await dialog.getByLabel('Reason (required)').fill('Beta ends on 1 Dec 2026');
    await dialog.getByRole('button', { name: 'Switch to Paid' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^Paid/u })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.getByRole('radio', { name: /^Beta — free/u }).click();
    await dialog.getByLabel('Reason (required)').fill('Back to the free beta');
    await dialog.getByRole('button', { name: 'Switch to Beta — free' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^Beta — free/u })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await context.close();
  });

  test('E2E-PA10-02: allowlisting Northstar for copilot shows its Ask', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(`/${NORTHSTAR}/search?q=launch`);
    await expect(member.page.getByRole('searchbox').first()).toBeVisible();
    await expect(member.page.getByRole('link', { name: 'Ask copilot' })).toHaveCount(0);

    const { context, page } = await openAdmin(browser, '/platform/settings/flags');
    const row = page.getByRole('row').filter({ hasText: 'copilot' });
    await row.getByRole('button', { name: 'Edit' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('switch').first().check();
    await drawer.getByRole('radio', { name: 'Chosen organizations' }).click();
    await drawer.getByLabel('Add an organization').fill('Northstar');
    await drawer.getByRole('button', { name: 'Add to allowlist' }).first().click();
    await drawer.getByRole('button', { name: 'Save flag' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(row).toContainText('Allowlist · 1 orgs');

    await member.page.reload();
    await expect(member.page.getByRole('link', { name: 'Ask copilot' })).toBeVisible();

    // Put the code default back for the rest of the suite.
    await row.getByRole('button', { name: 'Edit' }).click();
    await drawer.getByRole('switch').first().uncheck();
    await drawer.getByRole('radio', { name: 'Everyone' }).click();
    await drawer.getByRole('button', { name: 'Save flag' }).click();
    await expect(drawer).toHaveCount(0);
    await context.close();
    await member.context.close();
  });

  test('E2E-PA10-03: a published announcement shows inside Northstar in English and Arabic', async ({
    browser,
  }) => {
    const { context, page } = await openAdmin(browser, '/platform/settings/announcements');
    await page.getByRole('button', { name: 'New announcement' }).first().click();
    await page.getByLabel('Title', { exact: true }).fill('Planned maintenance on 2 Nov');
    await page.getByLabel('Message', { exact: true }).fill('TManage is read-only from 22:00.');
    await page.getByLabel('العنوان').fill('صيانة مجدولة يوم 2 نوفمبر');
    await page.getByLabel('الرسالة').fill('سيكون TManage للقراءة فقط من 22:00.');
    await page.getByRole('button', { name: 'Publish' }).click();
    const listed = page.getByRole('row').filter({ hasText: 'Planned maintenance on 2 Nov' });
    await expect(listed).toContainText('Live');

    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(`/${NORTHSTAR}/home`);
    const banner = member.page.getByTestId('platform-announcement');
    await expect(banner).toContainText('Planned maintenance on 2 Nov');
    await expect(banner).toHaveAttribute('dir', 'ltr');

    await member.page.goto(`/${NORTHSTAR}/home?lang=ar`);
    await expect(banner).toContainText('صيانة مجدولة يوم 2 نوفمبر');
    await expect(banner).toHaveAttribute('dir', 'rtl');
    await member.context.close();

    // Take it down again.
    await listed.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Unpublish' }).click();
    await expect(listed).toContainText('Draft');
    await context.close();
  });

  test('E2E-PA10-04: block sign-in refuses a member, lets a platform admin in, End now opens it', async ({
    browser,
  }) => {
    const { context, page } = await openAdmin(browser, '/platform/settings/maintenance');
    await page.getByRole('button', { name: 'New window' }).click();
    await page.getByLabel('Message — English').fill('TManage is down for an upgrade');
    await page.getByRole('radio', { name: 'Down' }).click();
    await page.getByLabel('Starts').fill(localInput(-5));
    await page.getByLabel('Ends').fill(localInput(120));
    await page.getByRole('switch', { name: 'Block sign-in for non-admins while down' }).check();
    await page.getByLabel('Reason (required)').fill('Database upgrade window');
    await page.getByRole('button', { name: 'Save window' }).click();
    const active = page.getByTestId('maintenance-active');
    await expect(active).toContainText('sign-in is blocked for everyone except platform admins');

    const refused = await passwordSignIn(browser, world().supportCandidate);
    expect(refused.status).toBe(403);
    expect(refused.message).toBe('TManage is down for an upgrade');
    const admitted = await passwordSignIn(browser, world().platformAdmin);
    expect(admitted.status).toBe(200);

    await active.getByRole('button', { name: 'End now' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('End maintenance now?')).toBeVisible();
    await dialog.getByRole('button', { name: 'End now' }).click();
    await expect(active).toHaveCount(0);

    const reopened = await passwordSignIn(browser, world().supportCandidate);
    expect(reopened.status).not.toBe(403);
    await context.close();
  });

  test('E2E-PA10-05: the Arabic settings page is right-to-left', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/settings');
    await page.goto('/platform/settings?lang=ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'إعدادات المنصة' })).toBeVisible();
    await expect(page.locator('#ai-access')).toBeVisible();
    await context.close();
  });
});
