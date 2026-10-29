import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-04 — the permission editors (D7 role matrix, D8 overrides) through a real
 * browser against the real stack.
 *
 * 1. The Northstar owner edits a custom role: ticks "Delete work items", sees the change listed
 *    against the saved role, saves, and the API returns the new set.
 * 2. The manager (no `org.manage`) cannot change a role: the API refuses the write with 403 and the
 *    editor shows no matrix to change.
 * 3. The owner adds a deny on `conversation.write` for the offboardee; the preview colours it
 *    "denied by an override".
 * 4. The platform super admin removes that override from /platform, with a reason.
 *
 * Fresh stack per run, one worker, serial: the journeys share the role and the override.
 */

interface User {
  readonly id: string;
  readonly email: string;
  readonly membershipId: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly owner: User;
    readonly manager: User;
    readonly offboardee: User;
  };
  readonly platformAdmin: { readonly id: string; readonly password: string };
}

const ORG = 'northstar-studio';
const DELETE_BOX = 'Delete work items in projects this person is on';

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page; headers: Record<string, string> }> {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  const csrf = (await context.cookies(API_URL)).find(
    (cookie) => cookie.name === 'tmanage_session_csrf',
  )?.value;
  const page = await context.newPage();
  return { context, page, headers: { 'x-csrf-token': csrf ?? '', origin: WEB_URL } };
}

async function stepUp(page: Page, password: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('platform-step-up-pill')).toContainText('Step-up valid');
}

const shared: { roleId: string } = { roleId: '' };

test.describe.serial('the permission editor journeys', () => {
  test('E2E-PA04-01: the owner edits a custom role and saves the change', async ({ browser }) => {
    const { context, page, headers } = await openAs(browser, world().northstar.owner.id);
    const created = await context.request.post(`${API_URL}/v1/organizations/${ORG}/admin/roles`, {
      headers,
      data: { name: `Delivery lead ${Date.now()}`, capabilities: ['work.read', 'work.create'] },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const list = (await created.json()) as { roles: { id: string; name: string }[] };
    const role = list.roles.find((entry) => entry.name.startsWith('Delivery lead'));
    expect(role).toBeTruthy();
    shared.roleId = role!.id;

    await page.goto(`/${ORG}/admin/roles/${shared.roleId}`);
    await page.getByRole('checkbox', { name: DELETE_BOX }).check();
    await expect(page.getByText('1 unsaved change')).toBeVisible();
    // The change list names the added cell, drawn as "+" then the cell label.
    const added = page.getByTestId('role-diff').locator('[data-change="added"]');
    await expect(added).toHaveCount(1);
    await expect(added).toContainText('Work items · delete');
    await page.getByRole('button', { name: 'Save role' }).click();
    await expect(page.getByText('1 unsaved change')).toHaveCount(0);

    const after = await context.request.get(`${API_URL}/v1/organizations/${ORG}/admin/roles`);
    const saved = ((await after.json()) as { roles: { id: string; capabilities: string[] }[] })
      .roles;
    expect(saved.find((entry) => entry.id === shared.roleId)?.capabilities).toContain(
      'work.delete',
    );
    await context.close();
  });

  test('E2E-PA04-02: a manager cannot widen a role (the API answers 403)', async ({ browser }) => {
    const { context, page, headers } = await openAs(browser, world().northstar.manager.id);
    const refused = await context.request.patch(
      `${API_URL}/v1/organizations/${ORG}/admin/roles/${shared.roleId}`,
      { headers, data: { name: 'Delivery lead', capabilities: ['billing.manage'] } },
    );
    expect(refused.status()).toBe(403);
    await page.goto(`/${ORG}/admin/roles/${shared.roleId}`);
    await expect(page.getByRole('checkbox', { name: DELETE_BOX })).toHaveCount(0);
    await context.close();
  });

  test('E2E-PA04-03: the owner denies conversation.write and the preview shows it', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    const member = world().northstar.offboardee.membershipId;
    await page.goto(`/${ORG}/people/${member}/permissions`);
    await page.getByLabel('Permission', { exact: true }).selectOption('conversation.write');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByLabel('Reason', { exact: true }).fill('Read-only during handover');
    await page.getByRole('button', { name: 'Add override' }).last().click();
    await page.getByRole('button', { name: 'Save overrides' }).click();
    await expect(page.getByTestId('effective-explain')).toHaveAttribute(
      'data-source',
      'override_deny',
    );
    await context.close();
  });

  test('E2E-PA04-04: a platform admin removes the override from /platform', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().platformAdmin.id);
    const { organizationId, offboardee } = world().northstar;
    await page.goto(
      `/platform/organizations/${organizationId}/members/${offboardee.membershipId}/permissions`,
    );
    await stepUp(page, world().platformAdmin.password);
    const row = page.getByTestId('override-list').locator('[data-capability="conversation.write"]');
    await expect(row).toBeVisible();
    await row.getByRole('button').click();
    await page.getByLabel('Reason (optional)').fill('Handover finished');
    await page.getByRole('button', { name: 'Save overrides' }).click();
    await expect(page.locator('[data-capability="conversation.write"]')).toHaveCount(0);
    await context.close();
  });
});
