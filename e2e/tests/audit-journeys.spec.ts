import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The Administration audit export — ADM-09 (x118), through a real browser against the real stack.
 *
 * The viewer read (x115) is proven by its web unit test; this journey proves the second, more
 * sensitive half end to end: an owner (who holds `audit.export`, a stronger grant than the
 * `audit.read` the viewer uses) opens the audit screen and downloads the trail as a CSV. The
 * assertion is that a real browser download starts and carries the forced-attachment filename the
 * API sets — i.e. the `Content-Disposition` reaches the wire and the link is a genuine download,
 * not an in-app navigation.
 *
 * SPEED RULE 1: shipped with the route, screen and DB case. Running it is chain 18's job (it needs
 * the seeded stack); this file is written and typechecked here.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: { readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

test.describe('the audit export journey', () => {
  test('ADM-09: an owner downloads the audit trail as a CSV attachment', async ({ browser }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);

    const page = await context.newPage();
    await page.goto('/northstar-studio/admin/audit');

    const exportLink = page.getByRole('link', { name: 'Export CSV' });
    await expect(exportLink).toBeVisible();

    // The click starts a real browser download — the API's attachment disposition, not a page nav.
    const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
    expect(download.suggestedFilename()).toBe('audit-events.csv');

    await context.close();
  });
});
