import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { asReturningPerson } from '../setup/journey-kit.js';
import { API_URL } from '../setup/stack.js';

/**
 * PROJ module 8 (x137) + SEC portal milestones (x139) — the projects portfolio roll-up and the
 * milestone timeline, through a real browser against the real stack.
 *
 * Two surfaces that no unit or DB case can prove together, because they cross the browser, both
 * apps and the tenant boundary:
 *
 * 1. **The portfolio is a real roll-up.** An internal reader opens `/{slug}/projects/portfolio`
 *    and sees one card per project they can see — the seeded project, its Active capsule, its
 *    open-work count and its objective tallies — and the card links through to the project.
 * 2. **A milestone an internal manager publishes reaches the client's timeline.** The manager adds
 *    a published milestone and a private draft on the project's Milestones tab; the client sees the
 *    published one on `/{slug}/portal/timeline` with its committed date and state, and never the
 *    draft. `published` is the visibility gate, exactly as it is for project updates.
 *
 * Serial on purpose: the client-timeline step reads the milestones the manager step posts.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly projectId: string;
    readonly projectName: string;
  };
  readonly atlas: {
    readonly reviewer: SeededUser;
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

// Unique titles, distinct from portal-updates' own milestones, because both files post to the same
// seeded project in the one shared database and the timeline shows every published milestone on it.
const PUBLISHED_MILESTONE = 'Design sign-off';
const DRAFT_MILESTONE = 'Internal budget review';
// A DATE column, so the browser (pinned to UTC + en-US in the config) renders it as a stable string.
const TARGET_DATE = '2026-12-01';
/** How the client timeline writes TARGET_DATE (`longDay`: en-GB day and month). */
const TARGET_DATE_TEXT = '1 December';

test.describe.serial('the projects portfolio and milestone journeys', () => {
  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await asReturningPerson(context);
    await signIn(context, userId);
    const page = await context.newPage();
    return { context, page };
  }

  test('the portfolio rolls the seeded project up into a card', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto('/northstar-studio/projects/portfolio');

      await expect(page.getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();

      // The card's link goes to the project's own overview.
      const link = page.getByRole('link', { name: world().northstar.projectName });
      await expect(link).toHaveAttribute(
        'href',
        `/northstar-studio/projects/${world().northstar.projectId}`,
      );

      // The redesigned row (POR-01) is labelled by the project's name and reads in dates: the
      // COMMITTED / FORECAST / CLIENT WAIT columns, each a value or an explicit dash.
      const card = page.getByRole('article', { name: world().northstar.projectName });
      await expect(card).toContainText('Committed');
      await expect(card).toContainText('Forecast');
      await expect(card).toContainText('Client wait');

      // The screen's standing promise: dates and counts, never a score — no percentage anywhere
      // on the row.
      await expect(card).not.toContainText('%');
    } finally {
      await context.close();
    }
  });

  test('the portfolio card links through to the project overview', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto('/northstar-studio/projects/portfolio');
      await page.getByRole('link', { name: world().northstar.projectName }).click();

      await expect(page).toHaveURL(
        new RegExp(`/northstar-studio/projects/${world().northstar.projectId}$`),
      );
      // ONEPAGE (B04): the overview opens on its Delivery block; milestones have their own tab.
      await expect(page.getByRole('region', { name: 'Delivery', exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a manager publishes a milestone and keeps a draft private', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      // ONEPAGE (B04): milestones live on the project's Milestones tab, where "Add milestone" opens
      // a dialog whose "Show on the client timeline" switch is on for a client project.
      await page.goto(`/northstar-studio/projects/${world().northstar.projectId}/milestones`);
      const milestones = page.getByRole('region', { name: 'Milestones' });
      const row = (name: string) =>
        milestones.getByRole('listitem').filter({ hasText: name }).first();

      const add = async (name: string, shown: boolean): Promise<void> => {
        await milestones.getByRole('button', { name: 'Add milestone' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add milestone' });
        await dialog.getByLabel('Name').fill(name);
        await dialog.getByLabel('Due').fill(TARGET_DATE);
        const toggle = dialog.getByRole('switch', { name: 'Show on the client timeline' });
        await expect(toggle).toBeChecked();
        if (!shown) await toggle.uncheck();
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(row(name)).toBeVisible();
      };

      // Published, then a draft kept to the studio: the list marks exactly the published one.
      await add(PUBLISHED_MILESTONE, true);
      await expect(row(PUBLISHED_MILESTONE)).toContainText('Client can see');
      await add(DRAFT_MILESTONE, false);
      await expect(row(DRAFT_MILESTONE)).not.toContainText('Client can see');
    } finally {
      await context.close();
    }
  });

  test('the client sees the published milestone on the timeline and not the draft', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, world().atlas.reviewer.id);
    try {
      await page.goto('/northstar-studio/portal/timeline');

      // The redesigned timeline: a milestone track, then "Every date, in order" — one row per
      // milestone with its status and the committed date written out (`longDay`, day-month).
      const track = page.getByRole('region', { name: 'Milestones' });
      await expect(
        track.getByRole('listitem').filter({ hasText: PUBLISHED_MILESTONE }),
      ).toBeVisible();

      const dates = page.getByRole('region', { name: 'Every date, in order' });
      const publishedRow = dates.getByRole('listitem').filter({ hasText: PUBLISHED_MILESTONE });
      await expect(publishedRow).toBeVisible();
      // The Milestones-tab dialog saves its Due as the date agreed with the client.
      await expect(publishedRow.getByText('Date agreed', { exact: true })).toBeVisible();
      await expect(publishedRow).toContainText(`Agreed for ${TARGET_DATE_TEXT}`);

      // The gate: the unpublished draft is nowhere on the client's page.
      await expect(page.getByText(DRAFT_MILESTONE)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // A9 — the Milestones tab: a manager moves the due date and takes the milestone off the client
  // timeline, and the client stops seeing it.
  test("a manager edits a milestone's due date and hides it from the client", async ({
    browser,
  }) => {
    const manager = await openAs(browser, world().northstar.owner.id);
    try {
      await manager.page.goto(
        `/northstar-studio/projects/${world().northstar.projectId}/milestones`,
      );
      const row = manager.page
        .getByRole('listitem')
        .filter({ hasText: PUBLISHED_MILESTONE })
        .first();
      await expect(row.getByText('Client can see')).toBeVisible();

      await row.getByRole('button', { name: `Edit ${PUBLISHED_MILESTONE}` }).click();
      const dialog = manager.page.getByRole('dialog', { name: 'Edit milestone' });
      await dialog.getByLabel('Due').fill('2026-12-12');
      await dialog.getByRole('switch', { name: 'Show on the client timeline' }).uncheck();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await expect(row).toContainText('Due Sat 12 Dec');
      await expect(row.getByText('Client can see')).toHaveCount(0);
    } finally {
      await manager.context.close();
    }

    const client = await openAs(browser, world().atlas.reviewer.id);
    try {
      await client.page.goto('/northstar-studio/portal/timeline');
      // The timeline has loaded: its date list, or its empty state when no other file's milestone
      // is shown to the client either.
      await expect(
        client.page.getByRole('region', { name: /^(Every date, in order|No milestones yet)$/u }),
      ).toBeVisible();
      await expect(client.page.getByText(PUBLISHED_MILESTONE)).toHaveCount(0);
    } finally {
      await client.context.close();
    }
  });
});
