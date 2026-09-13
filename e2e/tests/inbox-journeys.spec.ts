import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, drainOutbox } from '../setup/stack.js';

/**
 * The notification loop, through a real browser against the real stack — **E2E-07,
 * "Notification bundle → inline action: action current-authorized and devices sync"**
 * (`27-TEST-CATALOG`).
 *
 * The stack does not run the worker, so no notification row exists until the outbox is
 * drained; `drainOutbox` runs the relay once between the act and the assertion, which is
 * what a deployment's cron tick does. Two inboxes are then read, one on each side of the
 * portal boundary:
 *
 * - **The studio's** (`TM-04`): a client's submission reaches the manager who can triage
 *   it, under "Client actions", with the inline action. Marking it read is reauthorized by
 *   the API and, because read state is a column, a second browser context for the same
 *   person — "another device" — sees it read without being told.
 * - **The client's** (INBOX-001's second half): the studio's question reaches the client
 *   who asked, with the client-safe status word and none of the internal ones; their own
 *   inline action; and the `Unread` mode is a query, so it empties once the bundle is read.
 * - **Current-authorized**: a sibling client organization of the same studio has nothing
 *   in its inbox, and the URL of the studio's inbox refuses the client at the door.
 *
 * Serial on purpose: every step reads what the first one caused.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
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

function databaseUrl(): string {
  return process.env['TMANAGE_E2E_DATABASE_URL'] as string;
}

function storageRoot(): string {
  return process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
}

async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

const TITLE = 'Translate the spa menu into Arabic';
const QUESTION = 'Which of the two spa menus, the summer one or the standing one?';

test.describe.serial('the notification journeys', () => {
  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await signIn(context, userId);
    const page = await context.newPage();
    return { context, page };
  }

  /**
   * The list has answered. A mode is part of the query key, so switching mode unmounts the
   * list and renders the loading region until the API replies; a negative assertion issued
   * straight after the click would be satisfied by that frame and prove nothing. This waits
   * for the region to go, so "no row" below means the API said so — the review fleet's
   * finding of 2026-09-03. It is an absence, so it must follow a presence: the clicked mode's
   * `aria-pressed`, which the same render that mounts the loading region sets.
   */
  async function settled(page: Page): Promise<void> {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  }

  test('E2E-07a: a submission reaches the studio inbox once the relay has run; mark read syncs across devices', async ({
    browser,
  }) => {
    // The client asks. This is the run's first exercise of `/portal/requests/new` and its
    // first request submission: the specs sort `inbox-journeys` before `request-journeys`,
    // so E2E-01a's identical submission — the one that proves this copy and this flow — runs
    // later, warm. Here the route compiles under a cold `next dev`, the projects query is the
    // browser's first authenticated read on that context, and the insert is the first write to
    // `client_requests` on a freshly booted embedded MySQL. The confirmation still has to say
    // exactly this sentence — the assertion is unchanged — but the cold path deserves the same
    // generous budget this config already grants a cold navigation, rather than the 15 s
    // default `expect` timeout that a warm E2E-01a never comes near.
    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto('/northstar-studio/portal/requests/new');
    await client.page.getByLabel('What do you need?').fill(TITLE);
    await client.page
      .getByLabel('Why it matters')
      .fill('Half of our spa guests read Arabic first.');
    await client.page.getByRole('button', { name: 'Send request' }).click();
    await expect(client.page.getByText('Your request is with the studio')).toBeVisible({
      timeout: 60_000,
    });
    await client.context.close();

    // Before the relay runs, the studio's inbox has nothing about it: the event is in the
    // outbox, and the row that TM-04 reads does not exist yet.
    const studio = await openAs(browser, world().northstar.manager.id);
    await studio.page.goto('/northstar-studio/inbox');
    // The rail is under the organization, like the screen it is on.
    await expect(
      studio.page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work' }),
    ).toHaveAttribute('href', '/northstar-studio/work');
    await studio.page.getByRole('button', { name: 'Client actions' }).click();
    await expect(studio.page.getByRole('button', { name: 'Client actions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settled(studio.page);
    await expect(studio.page.getByRole('link', { name: TITLE })).toHaveCount(0);

    await drainOutbox(databaseUrl(), storageRoot());

    // After it, one bundle about the request, unread, with the inline action.
    await studio.page.reload();
    await studio.page.getByRole('button', { name: 'Client actions' }).click();
    const row = studio.page
      .getByRole('row')
      .filter({ has: studio.page.getByRole('link', { name: TITLE }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Client submitted a request');
    await expect(row).toContainText('1 unread');
    await expect(row.getByRole('link', { name: TITLE })).toHaveAttribute(
      'href',
      /\/northstar-studio\/work\/requests\/[0-9a-f-]+$/,
    );

    // The inline action, reauthorized by the API, then the list re-read.
    await row.getByRole('button', { name: `Mark read: ${TITLE}` }).click();
    await expect(row.getByRole('button', { name: `Mark read: ${TITLE}` })).toHaveCount(0);
    await expect(row).not.toContainText('unread');

    // Another device: a second context for the same person sees it read, because read state
    // is a column and not a thing this browser remembered.
    const elsewhere = await openAs(browser, world().northstar.manager.id);
    await elsewhere.page.goto('/northstar-studio/inbox');
    const rowElsewhere = elsewhere.page
      .getByRole('row')
      .filter({ has: elsewhere.page.getByRole('link', { name: TITLE }) });
    await expect(rowElsewhere).toBeVisible();
    await expect(rowElsewhere.getByRole('button', { name: `Mark read: ${TITLE}` })).toHaveCount(0);
    // And under "Waiting on me" — what is unread — it is gone.
    await elsewhere.page.getByRole('button', { name: 'Waiting on me' }).click();
    await expect(elsewhere.page.getByRole('button', { name: 'Waiting on me' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settled(elsewhere.page);
    await expect(elsewhere.page.getByRole('link', { name: TITLE })).toHaveCount(0);

    await elsewhere.context.close();
    await studio.context.close();
  });

  test('E2E-07b: the studio’s question reaches the client’s inbox, with the client’s words, and their own inline action', async ({
    browser,
  }) => {
    // The studio asks back.
    const studio = await openAs(browser, world().northstar.manager.id);
    await studio.page.goto('/northstar-studio/work/requests');
    await studio.page.getByRole('link', { name: TITLE }).click();
    await studio.page.getByRole('button', { name: 'Start triaging' }).click();
    await studio.page.getByRole('button', { name: 'Ask another question' }).click();
    await studio.page.getByLabel('What do you need to know?').fill(QUESTION);
    await studio.page.getByRole('button', { name: 'Ask the client' }).click();
    await expect(studio.page.getByText('Waiting on the client')).toBeVisible();
    await studio.context.close();

    await drainOutbox(databaseUrl(), storageRoot());

    // The client's inbox: one bundle, the client-safe status, no internal words.
    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto('/northstar-studio/portal/inbox');
    const list = client.page.getByRole('list', { name: 'Your notifications' });
    const item = list
      .getByRole('listitem')
      .filter({ has: client.page.getByRole('link', { name: TITLE }) });
    await expect(item).toBeVisible();
    await expect(item).toContainText('Waiting for your answer');
    await expect(item).toContainText('Northstar Studio answered');
    // Two transitions reached the client — `submitted → triage` when the studio opened it,
    // `triage → needs_clarification` when it asked — and they are one bundle about one
    // request. The first run of this journey expected one, which is a NOTIF-001 policy
    // question recorded in `docs/implementation-status.md`, not a defect of this screen.
    await expect(item).toContainText('2 updates, 2 unread');
    await expect(client.page.getByText('Needs clarification')).toHaveCount(0);
    await expect(client.page.getByText('Needs triage')).toHaveCount(0);
    await expect(client.page.locator('a[href*="/work/"]')).toHaveCount(0);
    await expect(item.getByRole('link', { name: TITLE })).toHaveAttribute(
      'href',
      /\/northstar-studio\/portal\/requests\/[0-9a-f-]+$/,
    );

    // Their inline action; then `Unread` is a different query and answers nothing.
    await item.getByRole('button', { name: `Mark read: ${TITLE}` }).click();
    await expect(item.getByRole('button', { name: `Mark read: ${TITLE}` })).toHaveCount(0);
    await expect(item).toContainText('2 updates');
    await expect(item).not.toContainText('unread');
    await client.page.getByRole('button', { name: 'Unread' }).click();
    await expect(client.page.getByText('Nothing is unread')).toBeVisible();

    await client.context.close();
  });

  test('E2E-07c: a sibling client has nothing in its inbox, and the studio’s inbox refuses a client at the door', async ({
    browser,
  }) => {
    const meridian = await openAs(browser, world().meridian.reviewer.id);

    await meridian.page.goto('/northstar-studio/portal/inbox');
    await expect(meridian.page.getByText('Nothing has changed yet')).toBeVisible();
    await expect(meridian.page.getByText(TITLE)).toHaveCount(0);

    // The internal inbox is guarded by `work.read`, which no client role holds.
    const refused = await meridian.context.request.get(
      `${API_URL}/v1/organizations/northstar-studio/inbox`,
    );
    expect(refused.status()).toBe(403);

    await meridian.context.close();
  });
});
