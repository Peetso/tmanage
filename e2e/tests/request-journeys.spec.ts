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

  test('E2E-01a: a client asks, and the studio hears a question back', async ({ browser }) => {
    // The client asks.
    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto('/northstar-studio/portal/requests/new');
    // Not a sleep: the screen's own readiness signal. The form ships disabled and enables only
    // once React has hydrated and the portal-projects query has answered, so an enabled title
    // field is the app saying it will keep what is typed next. Without this barrier `goto`
    // returns on `load`, and on a cold compile the first two fills landed before hydration and
    // were wiped by it.
    await expect(client.page.getByLabel('What do you need?')).toBeEnabled();
    await client.page.getByLabel('What do you need?').fill(TITLE);
    await client.page
      .getByLabel('Why it matters')
      .fill('The current hero still shows the spring offer.');
    await client.page.getByLabel('When you would like it').fill('2026-09-03');
    await client.page.getByRole('button', { name: 'Send request' }).click();
    await expect(client.page.getByText('Your request is with the studio')).toBeVisible();

    const detailLink = client.page.getByRole('link', { name: 'See this request' });
    const href = await detailLink.getAttribute('href');
    expect(href).toBeTruthy();
    requestUrl = href as string;

    // The studio opens the inbox, starts triaging, and asks back.
    const studio = await openAs(browser, world().northstar.manager.id);
    await studio.page.goto('/northstar-studio/work/requests');
    await studio.page.getByRole('link', { name: TITLE }).click();
    await studio.page.getByRole('button', { name: 'Start triaging' }).click();
    await studio.page.getByRole('button', { name: 'Ask another question' }).click();
    await studio.page.getByLabel('What do you need to know?').fill(QUESTION);
    await studio.page.getByRole('button', { name: 'Ask the client' }).click();

    // The studio's own screen now says whose move it is, and offers the one control §6 draws
    // out of `needs_clarification`. This panel did not exist before this journey was first run:
    // the screen used to offer commit/defer/decline here, and the API refused all three.
    await expect(studio.page.getByText('Waiting on the client')).toBeVisible();
    await expect(
      studio.page.getByRole('button', { name: 'The client has answered' }),
    ).toBeVisible();
    await expect(studio.page.getByRole('button', { name: 'Commit with a date' })).toHaveCount(0);

    // The client sees the question, word for word.
    await client.page.goto(requestUrl);
    await expect(client.page.getByText('Waiting for your answer')).toBeVisible();
    await expect(client.page.getByText('Northstar Studio has asked you something')).toBeVisible();
    await expect(client.page.getByText(QUESTION)).toBeVisible();

    // And withdrawing is still open to them. `23-ERD` §6 draws `needs_clarification → withdrawn`,
    // so the request is *not* out of their hands here — the first run of this journey was written
    // expecting the opposite, and the state machine settled it. The sentence is the clarifying
    // one rather than the submitted one, which is the second thing that run corrected.
    await expect(client.page.getByText('Withdrawing it is an answer too')).toBeVisible();
    await expect(client.page.getByRole('button', { name: 'Withdraw request' })).toBeVisible();

    await client.context.close();
    await studio.context.close();
  });

  test('E2E-01b: the studio commits, and the client reads the promise — not the machinery', async ({
    browser,
  }) => {
    // The studio, having heard back out-of-band, records that the answer arrived. §6 routes
    // every outcome through `triage`, so this step is the machine's, not the screen's.
    const studio = await openAs(browser, world().northstar.manager.id);
    await studio.page.goto('/northstar-studio/work/requests');
    await studio.page.getByRole('link', { name: TITLE }).click();
    await studio.page.getByRole('button', { name: 'The client has answered' }).click();

    // Now the outcomes are offered, and now the machine accepts them.
    await studio.page.getByRole('button', { name: 'Commit with a date' }).click();
    await studio.page.getByLabel('What are you agreeing to do?').fill(SCOPE);
    await studio.page.getByLabel('Committed date').fill('2026-09-10');
    // The gap between asked-for and promised is stated while composing, not hidden.
    await expect(studio.page.getByText('That is not the date they asked for')).toBeVisible();
    await studio.page.getByRole('button', { name: 'Review the commitment' }).click();
    await expect(studio.page.getByText('What the client will read')).toBeVisible();
    await studio.page.getByRole('button', { name: 'Commit and tell the client' }).click();
    await expect(studio.page.getByText('Accepted, and the work is committed')).toBeVisible();
    await expect(studio.page.getByRole('link', { name: 'Open the work item' })).toBeVisible();

    // The client's page: the promise, both dates, and none of the internals.
    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto(requestUrl);
    // Scoped to the status panel rather than asserted as exact text: `StateCapsule` prefixes an
    // `aria-hidden` glyph, and Playwright counts it — the capsule's text is "✓Accepted", so
    // `getByText('Accepted', { exact: true })` matches nothing. The first run of this suite
    // proved that on the invitation screen's identical capsule.
    await expect(client.page.getByRole('region', { name: 'Where this request is' })).toContainText(
      'Accepted',
    );
    await expect(client.page.getByText(SCOPE)).toBeVisible();
    // The date they asked for, by its label: on the day this journey runs on 2026-09-03 the
    // bare date also matches 'Sent September 3, 2026', and a strict locator refuses two.
    await expect(client.page.getByText('Asked for September 3, 2026')).toBeVisible();
    await expect(client.page.getByText('Agreed for September 10, 2026')).toBeVisible();
    // No internal state words, no door into the studio's workspace.
    await expect(client.page.getByText('Needs triage')).toHaveCount(0);
    await expect(client.page.getByRole('link', { name: 'Open the work item' })).toHaveCount(0);
    const internalLinks = client.page.locator('a[href*="/work/"]');
    await expect(internalLinks).toHaveCount(0);

    await client.context.close();
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
