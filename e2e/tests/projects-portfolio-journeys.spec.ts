import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
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
 *    a published milestone and a private draft on the project overview; the client sees the
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
const TARGET_DATE_TEXT = 'December 1, 2026';

test.describe.serial('the projects portfolio and milestone journeys', () => {
  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await signIn(context, userId);
    const page = await context.newPage();
    return { context, page };
  }

  test('the portfolio rolls the seeded project up into a card', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto('/northstar-studio/projects/portfolio');

      await expect(page.getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();

      // The card is the article labelled by the project's own name; the seed gives it one in-progress
      // work item, so its open-work count is a real, non-zero number rather than a placeholder.
      const link = page.getByRole('link', { name: world().northstar.projectName });
      await expect(link).toHaveAttribute(
        'href',
        `/northstar-studio/projects/${world().northstar.projectId}`,
      );

      const card = page.getByRole('article').filter({ has: link });
      await expect(card.getByText('Active')).toBeVisible();
      await expect(card.getByText('Open work')).toBeVisible();
      await expect(card.getByText('Objectives')).toBeVisible();
      await expect(card.getByText('Last activity')).toBeVisible();

      // The screen's standing promise: counts, never a score.
      await expect(
        page.getByText('These are counts, not a score.', { exact: false }),
      ).toBeVisible();
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
      await expect(page.getByRole('region', { name: 'Milestones' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a manager publishes a milestone and keeps a draft private', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto(`/northstar-studio/projects/${world().northstar.projectId}`);

      // The overview carries an update composer and a milestone composer, each with its own "Title"
      // field, so the milestone work is scoped to the Milestones region throughout.
      const milestones = page.getByRole('region', { name: 'Milestones' });
      await expect(milestones.getByRole('heading', { name: 'Milestones' })).toBeVisible();

      // Published — the checkbox defaults to "Publish to the client now".
      await milestones.getByLabel('Title').fill(PUBLISHED_MILESTONE);
      await milestones.getByLabel('Target date').fill(TARGET_DATE);
      await milestones.getByRole('button', { name: 'Add milestone' }).click();
      await expect(
        milestones.getByText('Your milestone is live in the client portal.'),
      ).toBeVisible();

      // A draft — unchecked, so it stays visible only to the studio.
      await milestones.getByLabel('Title').fill(DRAFT_MILESTONE);
      await milestones.getByLabel('Publish to the client now').uncheck();
      await milestones.getByRole('button', { name: 'Add milestone' }).click();
      await expect(
        milestones.getByText('Your draft is saved. It is not visible to the client.'),
      ).toBeVisible();

      // The internal list marks exactly the draft as a draft.
      const publishedRow = milestones
        .getByRole('listitem')
        .filter({ hasText: PUBLISHED_MILESTONE });
      const draftRow = milestones.getByRole('listitem').filter({ hasText: DRAFT_MILESTONE });
      await expect(publishedRow.getByText('Draft')).toHaveCount(0);
      await expect(draftRow.getByText('Draft')).toBeVisible();
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

      const milestones = page.getByRole('region', { name: 'Milestones' });
      await expect(milestones.getByRole('heading', { name: 'Milestones' })).toBeVisible();

      const publishedRow = milestones
        .getByRole('listitem')
        .filter({ hasText: PUBLISHED_MILESTONE });
      await expect(publishedRow.getByRole('heading', { name: PUBLISHED_MILESTONE })).toBeVisible();
      await expect(publishedRow.getByText('Planned')).toBeVisible();
      await expect(publishedRow.getByText(`Due ${TARGET_DATE_TEXT}`)).toBeVisible();

      // The gate: the unpublished draft is nowhere on the client's page.
      await expect(page.getByText(DRAFT_MILESTONE)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
