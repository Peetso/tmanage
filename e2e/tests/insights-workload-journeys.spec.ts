import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * INS-05 — the org-wide workload/capacity portfolio roll-up, through a real browser against the
 * real stack. An org-wide reader opens the Insights screen and finds the workload section: the
 * per-project table (heaviest first, as the API orders it) and the aggregate footer across every
 * project they may read. The read is `GET …/insights/workload` behind `work.read`; the section is
 * appended to `InsightsScreen`, so it renders on the same route INS-03 already ships.
 *
 * The security scoping the composition owns — cross-tenant exclusion (never a 500), non-org-wide
 * callers seeing only their projects, an empty roll-up rather than a 403 for a principal off every
 * project, and a client contributing nothing — is proven database-free in
 * `apps/api/src/modules/insights/insights-workload.test.ts` with the real `authorize`, and the
 * per-project workload read (x99 / WK-06) and project enumeration are already DB-proven. This
 * journey proves the browser wiring: the org-wide roll-up reaches the screen and renders
 * accessibly.
 *
 * The assertions are on the section's structure — heading, table caption, the aggregate footer —
 * not on exact counts, so the journey is stable whatever the seed's live open work is and whatever
 * a sibling journey moved through the state machine in the same fresh stack.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly projectId: string;
    /** An org-wide reader — sees the whole in-tenant portfolio in the roll-up. */
    readonly manager: SeededUser;
  };
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

async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await signIn(context, userId);
  const page = await context.newPage();
  return { context, page };
}

/** The Insights screen route the workload section is appended to (INS-03). */
function insightsUrl(organizationSlug: string, projectId: string): string {
  return `/${organizationSlug}/insights/projects/${projectId}`;
}

test.describe('INS-05 — the insights workload roll-up journey', () => {
  test('an org-wide reader sees the org-wide workload section on the Insights screen', async ({
    browser,
  }) => {
    const reader = await openAs(browser, world().northstar.manager.id);
    await reader.page.goto(insightsUrl('northstar-studio', world().northstar.projectId));

    // The section is present and named for what it is.
    await expect(
      reader.page.getByRole('heading', { name: 'Workload across projects' }),
    ).toBeVisible();

    // The roll-up renders as an accessible table with its aggregate footer — the shape holds
    // whether the live portfolio has open work or not (the empty state renders the same table).
    await expect(
      reader.page.getByRole('table', { name: 'Open work by project' }),
    ).toBeVisible();
    await expect(reader.page.getByRole('rowheader', { name: /^All projects \(/ })).toBeVisible();

    await reader.context.close();
  });
});
