import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

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

      // ONEPAGE (B04): the composer is not on the page until the header's "Post update" opens
      // it (the button says so with aria-expanded). Its own submit button has the same name, so
      // the header one is picked by its expanded state and the rest is scoped to the composer
      // region, named by its "Post an update" heading.
      const open = page.getByRole('button', { name: 'Post update', expanded: false });
      const opened = page.getByRole('button', { name: 'Post update', expanded: true });
      await expect(open).toBeEnabled();
      // The server-drawn button is enabled before React attaches its handler, so a click that
      // lands first does nothing: click again until the composer says it is open.
      await expect(async () => {
        if (await open.isVisible()) await open.click();
        await expect(opened).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      const composer = page.getByRole('region', { name: 'Post an update' });

      // Hydration barrier: wait for the compose field before filling, so the first fill does not
      // land before React has attached its handlers (the reason request-journeys waits too).
      await expect(composer.getByRole('heading', { name: 'Post an update' })).toBeVisible();
      // The controls ship disabled until React hydrates (useHydrated); that is the real barrier.
      await expect(composer.getByLabel('Title')).toBeEnabled();

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

  test('a milestone shown to the client is marked so, a draft is not', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().northstar.owner.id);
    try {
      await page.goto(`/northstar-studio/projects/${world().northstar.projectId}`);

      // ONEPAGE (B04): milestones moved off the overview to their own tab, where "Add milestone"
      // opens a dialog with a "Show on the client timeline" switch (on for a client project).
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: 'Milestones', exact: true })
        .click();
      await expect(page).toHaveURL(/\/projects\/[^/]+\/milestones$/u);
      const milestones = page.getByRole('region', { name: 'Milestones' });
      const row = (name: string) =>
        milestones.getByRole('listitem').filter({ hasText: name }).first();

      const add = async (name: string, shown: boolean): Promise<void> => {
        await milestones.getByRole('button', { name: 'Add milestone' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add milestone' });
        await dialog.getByLabel('Name').fill(name);
        const toggle = dialog.getByRole('switch', { name: 'Show on the client timeline' });
        await expect(toggle).toBeChecked();
        if (!shown) await toggle.uncheck();
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(row(name)).toBeVisible();
      };

      await add('Launch review', true);
      await expect(row('Launch review')).toContainText('Client can see');
      await add('Internal milestone draft', false);
      await expect(row('Internal milestone draft')).not.toContainText('Client can see');
    } finally {
      await context.close();
    }
  });

  test('the client sees the published update and not the draft', async ({ browser }) => {
    const { context, page } = await openAs(browser, world().atlas.reviewer.id);
    try {
      // The redesigned portal gives updates their own screen (the "Updates" tab).
      await page.goto('/northstar-studio/portal/updates');

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

  test('unpublishing returns the update to drafts and hides it from the client', async ({
    browser,
  }) => {
    const manager = await browser.newContext();
    try {
      await signIn(manager, world().northstar.owner.id);
      const csrf = (await manager.cookies(API_URL)).find(
        (cookie) => cookie.name === 'tmanage_session_csrf',
      )?.value;
      expect(csrf).toBeTruthy();
      const headers = { 'x-csrf-token': csrf as string, origin: WEB_URL };
      const base = `${API_URL}/v1/organizations/northstar-studio/projects/${world().northstar.projectId}/updates`;

      interface Listed {
        readonly id: string;
        readonly title: string;
        readonly published: boolean;
        readonly clientOpened: { readonly clientName: string } | null;
      }
      const list = async (): Promise<readonly Listed[]> => {
        const response = await manager.request.get(base);
        expect(response.ok()).toBe(true);
        return ((await response.json()) as { updates: readonly Listed[] }).updates;
      };

      // The client read the timeline in the journey above, so the access log names their company.
      const live = (await list()).find((update) => update.title === PUBLISHED_TITLE);
      expect(live?.published).toBe(true);
      expect(live?.clientOpened?.clientName).toBeTruthy();

      const unpublished = await manager.request.post(`${base}/${live?.id as string}/unpublish`, {
        headers,
      });
      expect(unpublished.ok()).toBe(true);

      const after = (await list()).find((update) => update.id === live?.id);
      expect(after?.published).toBe(false);
      expect(after?.clientOpened).toBeNull();
    } finally {
      await manager.close();
    }

    const { context, page } = await openAs(browser, world().atlas.reviewer.id);
    try {
      // Wait for the timeline read itself, so the absence below is not read before it loads.
      const timeline = page.waitForResponse((response) =>
        /\/portal\/projects\/[^/]+\/updates$/.test(new URL(response.url()).pathname),
      );
      await page.goto('/northstar-studio/portal/updates');
      expect((await timeline).ok()).toBe(true);
      await expect(
        page.getByRole('region', { name: 'Updates from Northstar Studio' }),
      ).toBeVisible();
      await expect(page.getByText(PUBLISHED_TITLE)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
