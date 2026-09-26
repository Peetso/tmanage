import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * INS-01 portfolio overview, through a real browser against the real stack (x120).
 *
 * The journey a member takes to answer "how are my projects doing" before drilling into one:
 * `/insights` is now the portfolio index (it was the deferred stub), so a member with `work.read`
 * lands on the roll-up across the projects they can read, then follows a drill-in link to a
 * project's own dashboard — the per-project delivery-flow / approval-cycle screen x109 built. The
 * exit assertion is the hop itself: the index names the seeded project and links to its dashboard,
 * and the dashboard the link opens is the real per-project insights screen, not a 404.
 *
 * The manager is org-wide, so the roll-up includes the seeded Northstar project; the assertion is
 * anchored on the drill-in href (which carries the project id) rather than the project's display
 * name, so it does not depend on the seed's naming.
 */

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly manager: { readonly id: string };
  };
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

test.describe('the insights portfolio journey', () => {
  test('E2E-INS: the portfolio index rolls up the readable projects and drills into a dashboard', async ({
    browser,
  }) => {
    const projectId = world().northstar.projectId;
    const viewer = await openAs(browser, world().northstar.manager.id);

    await viewer.page.goto('/northstar-studio/insights');

    // The portfolio index, not the old planned-screen stub.
    const portfolio = viewer.page.getByRole('region', { name: 'Portfolio', exact: true });
    await expect(portfolio).toBeVisible();

    // The seeded project appears with a drill-in link to its own dashboard.
    const link = viewer.page.locator(`a[href="/northstar-studio/insights/projects/${projectId}"]`);
    await expect(link.first()).toBeVisible();

    await link.first().click();

    // The link opens the real per-project insights dashboard (x109), not a 404.
    await expect(viewer.page).toHaveURL(new RegExp(`/insights/projects/${projectId}`, 'u'));
    await expect(
      viewer.page.getByRole('table', { name: /work items by workflow status/i }),
    ).toBeVisible();

    await viewer.context.close();
  });
});
