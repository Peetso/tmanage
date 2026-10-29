import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-07 — Organizations (A1–A7, A9) through a real browser against the real
 * stack: the overview, search, the profile with its unsaved guard and slug conflict, a role
 * change, suspend and reactivate, delete with the typed slug and restore, and the Arabic list.
 *
 * `world().platformAdmin` is on `PLATFORM_ADMIN_EMAILS`, so they hold every platform permission.
 * BrightOps carries the suspend and delete journeys, so Northstar stays as the rest of the suite
 * expects it; every journey puts back what it changed.
 */

interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

interface Member {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly northstar: { readonly organizationId: string; readonly offboardee: Member };
  readonly brightops: { readonly organizationId: string; readonly owner: Member };
}

const BRIGHTOPS = 'brightops-consulting';
const REASON = 'Customer support ticket 4821';

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

/** Fill the confirm dialog: the typed slug when asked, then the reason, then confirm. */
async function confirmAct(page: Page, button: string, slug?: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  if (slug) await dialog.getByLabel('Type the organization slug to confirm').fill(slug);
  await dialog.getByLabel('Reason (required)').fill(REASON);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe.serial('the platform organizations journeys', () => {
  test('E2E-PA07-01: the overview tiles load', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform');
    await expect(page.getByRole('heading', { level: 1, name: 'Platform overview' })).toBeVisible();
    const tiles = page.getByRole('list', { name: 'Platform overview' });
    await expect(tiles.getByRole('listitem')).toHaveCount(8);
    await expect(tiles.getByText('Organizations', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    await context.close();
  });

  test('E2E-PA07-02: search finds Northstar and opens it', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/organizations');
    await page.getByRole('searchbox', { name: 'Search organizations' }).fill('northstar');
    await expect(page.getByRole('link', { name: 'Northstar Studio', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'BrightOps Consulting' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Northstar Studio', exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/platform/organizations/${world().northstar.organizationId}$`, 'u'),
    );
    await expect(page.getByRole('heading', { name: 'Owners and admins' })).toBeVisible();
    await context.close();
  });

  test('E2E-PA07-03: edit name and slug — unsaved guard, then a 409 on BrightOps', async ({
    browser,
  }) => {
    const id = world().northstar.organizationId;
    const { context, page } = await openAdmin(browser, `/platform/organizations/${id}/settings`);
    const name = page.getByLabel('Organization name');
    await name.fill('Northstar Studio Ltd');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(name).toHaveValue('Northstar Studio');

    await page.getByLabel('Slug', { exact: true }).fill(BRIGHTOPS);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Another organization already uses this slug.')).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();

    await name.fill('Northstar Studio Ltd');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Unsaved changes')).toBeHidden();
    await name.fill('Northstar Studio');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Unsaved changes')).toBeHidden();
    await context.close();
  });

  test("E2E-PA07-04: change a member's role", async ({ browser }) => {
    const { northstar } = world();
    const { context, page } = await openAdmin(
      browser,
      `/platform/organizations/${northstar.organizationId}/members`,
    );
    const role = page.getByLabel(`Role · ${northstar.offboardee.displayName}`);
    await expect(role).toHaveValue('member');
    await role.selectOption('manager');
    await expect(role).toHaveValue('manager');
    await page.reload();
    await expect(page.getByLabel(`Role · ${northstar.offboardee.displayName}`)).toHaveValue(
      'manager',
    );
    await page.getByLabel(`Role · ${northstar.offboardee.displayName}`).selectOption('member');
    await expect(page.getByLabel(`Role · ${northstar.offboardee.displayName}`)).toHaveValue(
      'member',
    );
    await context.close();
  });

  test('E2E-PA07-05: suspend with a reason, the member is refused, reactivate', async ({
    browser,
  }) => {
    const { brightops } = world();
    const { context, page } = await openAdmin(
      browser,
      `/platform/organizations/${brightops.organizationId}/lifecycle`,
    );
    await page.getByRole('button', { name: 'Suspend…' }).click();
    await confirmAct(page, 'Suspend');
    await expect(page.getByText('This organization is suspended')).toBeVisible();

    const member = await openAs(browser, brightops.owner.id);
    const refused = await member.context.request.get(
      `${API_URL}/v1/organizations/${BRIGHTOPS}/members`,
    );
    expect(refused.status()).toBe(403);
    // The 0206 contract: a proved member of a suspended company gets 403 `forbidden` with the
    // suspended message (the resolver's `organization_suspended` is the audit code, not the body).
    const body = (await refused.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('forbidden');
    expect(body.error?.message).toMatch(/workspace is suspended/);

    await page.getByRole('button', { name: 'Reactivate…' }).click();
    await confirmAct(page, 'Reactivate');
    await expect(page.getByText('This organization is suspended')).toBeHidden();
    const admitted = await member.context.request.get(
      `${API_URL}/v1/organizations/${BRIGHTOPS}/members`,
    );
    expect(admitted.ok()).toBe(true);
    await member.context.close();
    await context.close();
  });

  test('E2E-PA07-06: delete with the typed slug, find it in Deleted, restore it', async ({
    browser,
  }) => {
    const { brightops } = world();
    const { context, page } = await openAdmin(
      browser,
      `/platform/organizations/${brightops.organizationId}/lifecycle`,
    );
    await page.getByRole('button', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type the organization slug to confirm').fill('brightops');
    await dialog.getByLabel('Reason (required)').fill(REASON);
    // A slug that does not match keeps Delete disabled: nothing can be deleted.
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Type the organization slug to confirm').fill(BRIGHTOPS);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('This organization is deleted', { exact: true })).toBeVisible();

    await page.goto('/platform/organizations/deleted');
    const row = page.getByRole('row').filter({ hasText: BRIGHTOPS });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Restore' }).click();
    await confirmAct(page, 'Restore');
    await expect(page.getByRole('row').filter({ hasText: BRIGHTOPS })).toHaveCount(0);
    await page.goto(`/platform/organizations/${brightops.organizationId}`);
    await expect(page.getByText('This organization is deleted', { exact: true })).toBeHidden();
    await context.close();
  });

  test('E2E-PA07-07: the Arabic organizations list is right-to-left', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/organizations');
    await page.goto('/platform/organizations?lang=ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'المؤسسات' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Northstar Studio', exact: true })).toBeVisible();
    await context.close();
  });
});
