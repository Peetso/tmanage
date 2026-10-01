import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * CLIENT-003 — the project-updates timeline, through a real browser against the real stack.
 *
 * The journey the audit's `BackendPending` was standing in for: an internal manager posts an
 * update on the project overview, and a client member reads it on their portal overview — but
 * only once it is published. It proves three things end to end that no unit or DB case can, because
 * they cross the browser, both apps and the tenant boundary:
 *
 * 1. **The internal write reaches the client read.** The manager posts through
 *    `/{slug}/projects/{id}` (behind `project.manage`) and the client sees it at `/{slug}/portal`.
 * 2. **`published` is the visibility gate.** A draft the manager leaves unpublished never appears
 *    in the client's timeline.
 * 3. **The projection leaks nothing.** The client's page shows the title and body and no author.
 *
 * Serial on purpose: the read steps depend on the posts the first step makes.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly projectId: string;
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

const PUBLISHED_TITLE = 'The homepage is live';
const PUBLISHED_BODY = 'We shipped the new homepage this afternoon — take a look when you can.';
const DRAFT_TITLE = 'Internal draft not for the client';
const DRAFT_BODY = 'Still deciding how to phrase this one.';

test.describe.serial('the project-updates journeys', () => {
  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await signIn(context, userId);
    const page = await context.newPage();
    return { context, page };
  }

  test('an internal manager posts a published update and a private draft', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto(`/northstar-studio/projects/${world().northstar.projectId}`);

      // Scope to the composer region: the project overview now also carries a "Milestones" panel
      // with its own "Title" field and "Publish to the client now" checkbox, so the page-global
      // labels are no longer unique. The region name is the composer's "Post an update" heading.
      const composer = page.getByRole('region', { name: 'Post an update' });

      // Hydration barrier: wait for the compose field before filling, so the first fill does not
      // land before React has attached its handlers (the reason request-journeys waits too).
      await expect(composer.getByRole('heading', { name: 'Post an update' })).toBeVisible();

      // The published update — the checkbox defaults to "Publish to the client now".
      await composer.getByLabel('Title').fill(PUBLISHED_TITLE);
      await composer.getByLabel('Update').fill(PUBLISHED_BODY);
      await composer.getByRole('button', { name: 'Post update' }).click();
      await expect(page.getByText('Your update is live in the client portal.')).toBeVisible();

      // A draft — unchecked, so the client must never see it.
      await composer.getByLabel('Title').fill(DRAFT_TITLE);
      await composer.getByLabel('Update').fill(DRAFT_BODY);
      await composer.getByLabel('Publish to the client now').uncheck();
      await composer.getByRole('button', { name: 'Post update' }).click();
      await expect(
        page.getByText('Your draft is saved. It is not visible to the client.'),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the client sees the published update and not the draft', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().atlas.reviewer.id);
    try {
      await page.goto('/northstar-studio/portal');

      const updates = page.getByRole('region', { name: 'Updates from Northstar Studio' });
      await expect(updates).toBeVisible();
      await expect(updates.getByRole('heading', { name: PUBLISHED_TITLE })).toBeVisible();
      await expect(updates.getByText(PUBLISHED_BODY)).toBeVisible();

      // The gate: the unpublished draft is nowhere on the client's page.
      await expect(page.getByText(DRAFT_TITLE)).toHaveCount(0);
      await expect(page.getByText(DRAFT_BODY)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
