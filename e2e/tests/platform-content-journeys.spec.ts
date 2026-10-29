import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-08 — Content browser, moderation and trash (B5–B7) through a real browser
 * against the real stack.
 *
 * The Northstar owner writes a channel message through the API. The bootstrap super admin steps up
 * and opens Content: without a live support session the screen shows the inline prompt (428), and
 * opening a session there loads the content in place. They read the channel, edit the message,
 * delete it with a reason (members see "Removed by TManage support"), restore it from Deleted
 * items, and look at the Files area.
 *
 * Fresh stack per run, one worker, serial: the journey opens a support session and ends it.
 */

interface World {
  readonly platformAdmin: {
    readonly id: string;
    readonly email: string;
    readonly password: string;
  };
  readonly northstar: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly owner: { readonly id: string };
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const CHANNEL = 'pa08-support-desk';
const MESSAGE = 'Please call me on 0100 555 0199 about the invoice';
const EDITED = 'Please call me about the invoice (number removed by support)';

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
  expect(csrf).toBeTruthy();
  const page = await context.newPage();
  return { context, page, headers: { 'x-csrf-token': csrf as string, origin: WEB_URL } };
}

/** The super admin, signed in and stepped up (every Platform admin call needs the step-up). */
async function openAdmin(browser: Browser) {
  const opened = await openAs(browser, world().platformAdmin.id);
  const stepUp = await opened.context.request.post(`${API_URL}/v1/platform/step-up`, {
    headers: opened.headers,
    data: { password: world().platformAdmin.password },
  });
  expect(stepUp.ok(), await stepUp.text()).toBe(true);
  return opened;
}

test.describe.serial('Platform content journeys', () => {
  let conversationId = '';
  let messageId = '';

  test.beforeAll(async ({ browser }) => {
    const owner = await openAs(browser, world().northstar.owner.id);
    const base = `${API_URL}/v1/organizations/northstar-studio/conversations`;
    const created = await owner.context.request.post(base, {
      headers: owner.headers,
      data: { projectId: world().northstar.projectId, name: CHANNEL },
    });
    expect(created.status(), await created.text()).toBe(201);
    conversationId = ((await created.json()) as { id: string }).id;
    const posted = await owner.context.request.post(`${base}/${conversationId}/messages`, {
      headers: owner.headers,
      data: { body: MESSAGE },
    });
    expect(posted.ok(), await posted.text()).toBe(true);
    messageId = ((await posted.json()) as { id: string }).id;
    await owner.context.close();
  });

  test('E2E-PA08-01: no session shows the prompt; opening one loads the content in place', async ({
    browser,
  }) => {
    const { context, page } = await openAdmin(browser);

    const orgId = world().northstar.organizationId;
    const refused = await context.request.get(
      `${API_URL}/v1/platform/organizations/${orgId}/content`,
    );
    expect(refused.status()).toBe(428);

    await page.goto(`${WEB_URL}/platform/organizations/${orgId}/content`);
    const prompt = page.getByTestId('support-session-needed');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('428');
    await prompt.getByRole('button', { name: /Open support session/ }).click();

    await expect(page.getByTestId('content-support-strip')).toBeVisible();
    await expect(page.getByTestId('content-browser')).toBeVisible();

    // Browse the channel, read the message, edit it as support.
    await page.getByRole('button', { name: new RegExp(`^${CHANNEL}`) }).click();
    const stream = page.getByTestId('content-stream');
    await expect(stream).toContainText(MESSAGE);
    await stream.getByRole('button', { name: new RegExp(MESSAGE.slice(0, 20)) }).click();
    await expect(page.getByTestId('content-selected-meta')).toContainText(messageId);

    const viewer = page.getByTestId('content-viewer');
    await viewer.getByRole('button', { name: 'Edit' }).click();
    const form = page.getByTestId('content-edit');
    await expect(form).toContainText('EDITING AS TMANAGE SUPPORT');
    await form.getByRole('textbox', { name: 'Message' }).fill(EDITED);
    await expect(form).toContainText('Unsaved changes');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(stream).toContainText(EDITED);

    // Delete with a reason: the message stays in place, struck through.
    await viewer.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: /Delete this message/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('Owner asked us to remove the phone number');
    await dialog.getByRole('button', { name: 'Delete with reason' }).click();
    await expect(stream.getByTestId('content-removed').first()).toContainText(
      'Removed by TManage support',
    );
    await context.close();
  });

  test('E2E-PA08-02: the deleted message is in Deleted items, via support, and restores', async ({
    browser,
  }) => {
    const { page } = await openAdmin(browser);
    const orgId = world().northstar.organizationId;
    await page.goto(`${WEB_URL}/platform/organizations/${orgId}/content/trash`);
    const trash = page.getByTestId('content-trash');
    await expect(trash).toBeVisible();
    const row = trash.getByRole('row', { name: /number removed by support/ });
    await expect(row).toContainText('via support');
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(trash.getByRole('row', { name: /number removed by support/ })).toHaveCount(0);

    const restored = await page.request.get(
      `${API_URL}/v1/platform/organizations/${orgId}/content/messages/${messageId}`,
    );
    expect(restored.ok()).toBe(true);
    const body = (await restored.json()) as { item: { deletedAt: string | null } };
    expect(body.item.deletedAt).toBeNull();
  });

  test('E2E-PA08-03: Files shows the metadata table or the empty state, never raw content', async ({
    browser,
  }) => {
    const { page } = await openAdmin(browser);
    const orgId = world().northstar.organizationId;
    await page.goto(`${WEB_URL}/platform/organizations/${orgId}/content`);
    await page.getByRole('button', { name: /^Files/ }).click();
    const table = page.getByRole('table', { name: 'Files' });
    const empty = page.getByText('Nothing in this area');
    await expect(table.or(empty)).toBeVisible();
    if (await table.isVisible()) {
      for (const header of ['NAME', 'SIZE', 'LOCATION', 'UPLOADER', 'SCAN', 'VER']) {
        await expect(table.getByRole('columnheader', { name: header })).toBeVisible();
      }
    }
  });
});
