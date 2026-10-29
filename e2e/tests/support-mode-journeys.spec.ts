import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-05 — Support mode (A8) through a real browser against the real stack.
 *
 * `world().platformAdmin` is the bootstrap super admin. They step up, enter Northstar in Support
 * mode through the API (the same call the enter dialog makes), and land on the organization's
 * pages with the red banner on top; Exit ends the session and takes the access away again.
 *
 * Fresh stack per run, one worker, serial: the journey opens and ends sessions it does not restore.
 */

interface World {
  readonly platformAdmin: {
    readonly id: string;
    readonly email: string;
    readonly password: string;
  };
  readonly northstar: { readonly organizationId: string; readonly slug?: string };
}

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
  expect(csrf).toBeTruthy();
  const page = await context.newPage();
  return { context, page, headers: { 'x-csrf-token': csrf as string, origin: WEB_URL } };
}

test.describe.serial('Support mode journeys', () => {
  test('E2E-PA05-01: enter, see the red banner, exit, and lose access', async ({ browser }) => {
    const { context, page, headers } = await openAs(browser, world().platformAdmin.id);
    const stepUp = await context.request.post(`${API_URL}/v1/platform/step-up`, {
      headers,
      data: { password: world().platformAdmin.password },
    });
    expect(stepUp.ok(), await stepUp.text()).toBe(true);

    const enter = await context.request.post(
      `${API_URL}/v1/platform/organizations/${world().northstar.organizationId}/support-session`,
      { headers, data: { minutes: 30, reason: 'E2E support journey' } },
    );
    expect(enter.status(), await enter.text()).toBe(201);
    const started = (await enter.json()) as { id: string; slug: string; redirectTo: string };

    await page.goto(started.redirectTo);
    const banner = page.getByRole('region', { name: 'Support mode' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(world().platformAdmin.email);
    await expect(banner.getByRole('link', { name: /View my actions/ })).toHaveAttribute(
      'href',
      `/platform/activity?supportSessionId=${started.id}`,
    );

    await banner.getByRole('button', { name: 'Exit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Exit Support mode?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Exit Support mode' }).click();
    await page.waitForURL(/\/platform/);

    const after = await context.request.get(
      `${API_URL}/v1/organizations/${started.slug}/support-session`,
    );
    expect(after.ok()).toBe(false);
    await context.close();
  });
});
