import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * TEST-003's first two journeys, through a real browser against the real stack.
 *
 * - **E2E-02, "Message → task: source and linked badge; no duplicate on retry"** — the
 *   whole path a person walks: create a channel, say something, convert it to work, see
 *   the link, convert again and be handed the SAME item. INT-07's guarantee, watched from
 *   the outside for the first time.
 * - **AUTH-04, "Member converts message in inaccessible conversation: deny, no source
 *   leak"** — a member of the organization who is not in the channel opens its URL and
 *   learns nothing: not the message, not the channel's existence beyond a load error.
 *
 * - **E2E-DM, "a member starts a direct message and the other member reads it"** (A4) — New
 *   message from the chat column, Open conversation, send; the other member sees the unread pill,
 *   opens the conversation and the pill is gone (the screen marked it read).
 *
 * Serial on purpose: the second journey visits the room the first one made, which is the
 * honest shape of the scenario — the denial is about a room where something was said.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly designer: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/**
 * The dev sign-in route the API registers outside production — a session, not a mock.
 *
 * Returns the CSRF token the route issues, which a direct `context.request` mutation must echo in
 * `X-CSRF-Token` exactly as the web client does, or `CsrfGuard` refuses it with 403.
 */
async function signIn(context: BrowserContext, userId: string): Promise<string> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return csrfToken;
}

const CONVERSATIONS = `${API_URL}/v1/organizations/northstar-studio/conversations`;

/** The conversation id at the end of a `/northstar-studio/chat/<id>` URL. */
function conversationIdOf(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  expect(id, `no conversation id in ${url}`).toBeTruthy();
  return id as string;
}

const MESSAGE = 'Ship the launch checklist by Friday';

test.describe.serial('the chat journeys', () => {
  let channelUrl: string;

  test('E2E-02: a message becomes work exactly once', async ({ browser }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();

    // Create the room. Two "Project" selects exist (the filter's and the form's); scope
    // to the form's section, and wait for the projects query to fill its options.
    await page.goto('/northstar-studio/chat');
    const form = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'New channel' }) });
    await expect(form.getByRole('option', { name: 'Atlas Website Relaunch' })).toBeAttached();
    await form.getByLabel('Project').selectOption({ label: 'Atlas Website Relaunch' });
    await form.getByLabel('Channel name').fill('e2e-room');
    await form.getByRole('button', { name: 'Create channel' }).click();

    // Enter it and say the thing.
    // The chat column lists the room too (its name carries the project); take the browser's row.
    await page.getByRole('main').getByRole('link', { name: '#e2e-room', exact: true }).click();
    await expect(page.getByLabel('Message the channel')).toBeVisible();
    channelUrl = page.url();
    await page.getByLabel('Message the channel').fill(MESSAGE);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(MESSAGE)).toBeVisible();

    // Convert it. The redesigned transcript shows a message's actions on hover (or focus), as
    // a pointer user meets them: rest on the message first, then take the action.
    const posted = page
      .getByRole('list', { name: 'Messages, oldest first' })
      .getByRole('listitem')
      .filter({ hasText: MESSAGE });
    await posted.hover();
    await page.getByRole('button', { name: 'Create work from this' }).click();
    await expect(page.getByLabel('Title')).toHaveValue(MESSAGE);
    await page.getByRole('button', { name: 'Create work item' }).click();
    await expect(page.getByText('Work item created')).toBeVisible();
    const link = page.getByRole('link', { name: MESSAGE });
    await expect(link).toBeVisible();
    const workItemHref = await link.getAttribute('href');
    await page.getByRole('button', { name: 'Close' }).click();

    // Convert it AGAIN — the retry that must not duplicate.
    await posted.hover();
    await page.getByRole('button', { name: 'Create work from this' }).click();
    await page.getByRole('button', { name: 'Create work item' }).click();
    await expect(page.getByText('Already converted')).toBeVisible();
    await expect(page.getByRole('link', { name: MESSAGE })).toHaveAttribute(
      'href',
      workItemHref as string,
    );

    await context.close();
  });

  test('AUTH-04: a member outside the room is denied, and nothing leaks', async ({ browser }) => {
    const designerId = world().northstar.designer.id;
    const conversationId = conversationIdOf(channelUrl);

    // Make the designer a real outsider. She is on the Atlas project, and since CQ-12 (COL-01) a
    // new project channel enrols the whole project team, so E2E-02's room put her in it. The owner
    // takes her out through the product's own route; she keeps her org and project access, so
    // what remains between her and the room is the channel-membership gate alone.
    const owner = await browser.newContext();
    const ownerCsrf = await signIn(owner, world().northstar.owner.id);
    const members = await owner.request.get(`${CONVERSATIONS}/${conversationId}/members`);
    expect(members.ok()).toBe(true);
    expect(JSON.stringify(await members.json()), 'CQ-12 enrolled the designer').toContain(
      designerId,
    );
    const removed = await owner.request.delete(
      `${CONVERSATIONS}/${conversationId}/members/${designerId}`,
      { headers: { 'X-CSRF-Token': ownerCsrf } },
    );
    expect(removed.status()).toBe(204);
    await owner.close();

    const context = await browser.newContext();
    await signIn(context, designerId);

    // The API refuses her outright — the same 404 an id that does not exist would get.
    const direct = await context.request.get(`${CONVERSATIONS}/${conversationId}/messages`);
    expect(direct.status()).toBe(404);
    expect(await direct.text()).not.toContain(MESSAGE);
    const page = await context.newPage();

    await page.goto(channelUrl);
    await expect(page.getByText('Could not load this channel')).toBeVisible();
    // The denial must not carry the source: neither the message nor a composer to reach it.
    await expect(page.getByText(MESSAGE)).toHaveCount(0);
    await expect(page.getByLabel('Message the channel')).toHaveCount(0);

    await context.close();
  });

  test('E2E-DM: a member starts a direct message and the other member reads it', async ({
    browser,
  }) => {
    const ownerId = world().northstar.owner.id;
    const designerId = world().northstar.designer.id;
    const text = `E2E-DM hello ${Date.now()}`;

    const owner = await browser.newContext();
    await signIn(owner, ownerId);
    const roster = await owner.request.get(`${API_URL}/v1/organizations/northstar-studio/members`);
    expect(roster.ok()).toBe(true);
    const { members } = (await roster.json()) as {
      members: { userId: string; displayName: string }[];
    };
    const ownerName = members.find((m) => m.userId === ownerId)?.displayName as string;
    const designerName = members.find((m) => m.userId === designerId)?.displayName as string;
    expect(ownerName && designerName, 'both seeded members are in the roster').toBeTruthy();

    const page = await owner.newPage();
    await page.goto('/northstar-studio/chat');
    await page.getByRole('button', { name: 'New message' }).click();
    const dialog = page.getByRole('dialog', { name: 'New message' });
    await dialog.getByLabel('To').fill(designerName.split(' ')[0] as string);
    await dialog.getByRole('button', { name: new RegExp(designerName) }).click();
    await dialog.getByRole('button', { name: 'Open conversation' }).click();
    await expect(page).toHaveURL(/\/northstar-studio\/chat\/dm\//u);
    const composer = page.getByLabel(`Message ${designerName}`);
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(text)).toBeVisible();
    await owner.close();

    const designer = await browser.newContext();
    await signIn(designer, designerId);
    const other = await designer.newPage();
    await other.goto('/northstar-studio/chat');
    const row = other
      .getByRole('navigation')
      .getByRole('link', { name: new RegExp(`${ownerName}.*unread`, 'u') });
    await expect(row).toBeVisible();
    await row.click();
    await expect(other.getByText(text)).toBeVisible();
    // Opening it marked it read: the row carries no unread count any more.
    await other.goto('/northstar-studio/chat');
    await expect(
      other.getByRole('navigation').getByRole('link', { name: new RegExp(ownerName, 'u') }),
    ).toBeVisible();
    await expect(
      other
        .getByRole('navigation')
        .getByRole('link', { name: new RegExp(`${ownerName}.*unread`, 'u') }),
    ).toHaveCount(0);
    await designer.close();
  });
});
