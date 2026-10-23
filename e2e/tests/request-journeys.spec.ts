import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The client-request loop, through a real browser against the real stack.
 *
 * - **E2E-01, "Client request → clarification → accepted work: client sees committed
 *   scope/date; no internal notes"** — a client asks, the studio asks back, the studio
 *   commits, and the client's page shows the promise and the date and none of the
 *   machinery. One deliberate divergence from the catalog's sentence, recorded in
 *   `docs/implementation-status.md` when REQ-001 landed: the client cannot *answer* the
 *   clarification in the portal — the screen itself says to reply out-of-band — so this
 *   journey proves the question arrives, that the studio records the answer arriving, and
 *   that the loop closes from the studio's side. That recording step is "The client has
 *   answered", and it exists because this journey's first run found the loop deadlocked:
 *   the triage screen offered commit, defer and decline in `needs_clarification`, and the
 *   state machine refuses all three from there. `23-ERD` §6 routes every outcome back
 *   through `triage`, and now the screen does too.
 * - **A7 (fq9-triage)** replaced the old outcome buttons: the studio now replies in the request's
 *   reply box, accepts through "Accept this request?", and can defer until a day and reopen —
 *   E2E-01a/b were rewritten onto that screen and E2E-01c added.
 * - **AUTH-06, "Atlas client queries another client request: deny"** — a member of a
 *   *sibling client organization of the same studio* opens the request's URL and gets the
 *   same not-found the request would give if it did not exist.
 *
 * Serial on purpose: every later step visits the request the first one created.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly manager: SeededUser;
  };
  readonly atlas: {
    readonly admin: SeededUser;
  };
  readonly meridian: {
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

const TITLE = 'Refresh the homepage hero for autumn';
const QUESTION = 'Which markets does the autumn campaign cover?';
const SCOPE = 'A refreshed homepage hero for the autumn campaign, both markets';
const DEFERRED_TITLE = 'Spring campaign ideas for the pool bar';

test.describe.serial('the client-request journeys', () => {
  let requestUrl: string;

  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await signIn(context, userId);
    const page = await context.newPage();
    return { context, page };
  }

  /** The client files a request in the portal and the test keeps its page's URL. */
  async function clientAsks(page: Page, title: string): Promise<string> {
    await page.goto('/northstar-studio/portal/requests/new');
    // Not a sleep: the screen's own readiness signal. The form ships disabled and enables only
    // once React has hydrated and the portal-projects query has answered.
    await expect(page.getByLabel('The request')).toBeEnabled();
    await page.getByLabel('The request').fill(title);
    await page.getByLabel('Why it matters').fill('The current hero still shows the spring offer.');
    await page.getByLabel('When you would like it').fill('2026-09-03');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(
      page.getByRole('heading', { name: 'Your request is with the studio' }),
    ).toBeVisible();
    const href = await page.getByRole('link', { name: 'See this request' }).getAttribute('href');
    expect(href).toBeTruthy();
    return href as string;
  }

  /** The studio opens a request from the inbox onto the A7 triage screen. */
  async function studioOpens(page: Page, title: string): Promise<void> {
    await page.goto('/northstar-studio/work/requests');
    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }

  test('E2E-01a: a client asks, and the studio replies on the request', async ({ browser }) => {
    const client = await openAs(browser, world().atlas.admin.id);
    requestUrl = await clientAsks(client.page, TITLE);

    // The studio opens it from the inbox and answers in the reply box (A7, fq9-triage).
    const studio = await openAs(browser, world().northstar.manager.id);
    await studioOpens(studio.page, TITLE);
    await expect(studio.page.getByRole('tab', { name: /New/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await studio.page.getByRole('textbox', { name: /^Reply to / }).fill(QUESTION);
    await studio.page.getByRole('button', { name: 'Send reply' }).click();
    await expect(studio.page.getByText('Reply sent.')).toBeVisible();

    // The client reads the reply, word for word, on their request.
    await client.page.goto(requestUrl);
    await expect(client.page.getByText(QUESTION)).toBeVisible();

    await client.context.close();
    await studio.context.close();
  });

  test('E2E-01b: the studio accepts, and the client reads the promise — not the machinery', async ({
    browser,
  }) => {
    const studio = await openAs(browser, world().northstar.manager.id);
    await studioOpens(studio.page, TITLE);

    // Accept opens the confirm (fq9-confirm-accept): the request, its project and sender, the
    // Owner and Due chips — Due starts on the day the client asked for.
    await studio.page.getByRole('button', { name: 'Accept', exact: true }).click();
    const dialog = studio.page.getByRole('dialog', { name: 'Accept this request?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(TITLE)).toBeVisible();
    await dialog.getByRole('button', { name: 'Accept request' }).click();
    await expect(studio.page.getByText('Accepted. The work item is in the plan.')).toBeVisible();
    await expect(studio.page.getByRole('link', { name: 'Open work item' })).toBeVisible();

    // The client's page: accepted, the agreed date, and none of the internals.
    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto(requestUrl);
    await expect(client.page.getByText('Accepted', { exact: true })).toBeVisible();
    await expect(client.page.getByRole('region', { name: 'Where this request is' })).toContainText(
      'The studio has taken this on.',
    );
    await expect(client.page.getByText('Agreed for September 3, 2026')).toBeVisible();
    await expect(client.page.getByText('Needs triage')).toHaveCount(0);
    await expect(client.page.getByRole('link', { name: 'Open work item' })).toHaveCount(0);
    await expect(client.page.locator('a[href*="/work/"]')).toHaveCount(0);

    await client.context.close();
    await studio.context.close();
  });

  test('E2E-01c: the studio defers a request and reopens it', async ({ browser }) => {
    const client = await openAs(browser, world().atlas.admin.id);
    await clientAsks(client.page, DEFERRED_TITLE);
    await client.context.close();

    const studio = await openAs(browser, world().northstar.manager.id);
    await studioOpens(studio.page, DEFERRED_TITLE);

    // Defer until the panel's day, with the reminder ticked (its default).
    await expect(
      studio.page.getByRole('checkbox', { name: 'Reopen it on this date and remind me' }),
    ).toBeChecked();
    await studio.page.getByRole('button', { name: 'Defer', exact: true }).click();

    // It now sits in the Deferred group with its return date, and the Deferred tab counts it.
    const list = studio.page.getByRole('region', { name: 'Requests' });
    await expect(list.getByText(/^Back on /)).toBeVisible();
    await expect(studio.page.getByRole('tab', { name: /Deferred/ })).toContainText(/\d/);

    // Reopen now brings it back to triage: the actions are offered again.
    await list.getByRole('button', { name: 'Reopen now' }).click();
    await expect(list.getByText(/^Back on /)).toHaveCount(0);
    await expect(studio.page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();

    await studio.context.close();
  });

  test('AUTH-06: a sibling client of the same studio is told nothing exists', async ({
    browser,
  }) => {
    const meridian = await openAs(browser, world().meridian.reviewer.id);

    await meridian.page.goto(requestUrl);
    await expect(meridian.page.getByText('Could not load this request')).toBeVisible();
    await expect(meridian.page.getByText('The requested resource was not found')).toBeVisible();
    // The denial carries nothing of the request: not its title, not the scope, not a date.
    await expect(meridian.page.getByText(TITLE)).toHaveCount(0);
    await expect(meridian.page.getByText(SCOPE)).toHaveCount(0);
    await expect(meridian.page.getByText('September 10, 2026')).toHaveCount(0);

    // And their own list does not gain the sibling's request.
    await meridian.page.goto('/northstar-studio/portal/requests');
    await expect(meridian.page.getByText('You have not asked for anything yet')).toBeVisible();
    await expect(meridian.page.getByText(TITLE)).toHaveCount(0);

    await meridian.context.close();
  });
});
