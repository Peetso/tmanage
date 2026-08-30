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

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
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
    await page.getByRole('link', { name: '#e2e-room' }).click();
    await expect(page.getByLabel('Message the channel')).toBeVisible();
    channelUrl = page.url();
    await page.getByLabel('Message the channel').fill(MESSAGE);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(MESSAGE)).toBeVisible();

    // Convert it.
    await page.getByRole('button', { name: 'Create work from this' }).click();
    await expect(page.getByLabel('Title')).toHaveValue(MESSAGE);
    await page.getByRole('button', { name: 'Create work item' }).click();
    await expect(page.getByText('Work item created')).toBeVisible();
    const link = page.getByRole('link', { name: MESSAGE });
    await expect(link).toBeVisible();
    const workItemHref = await link.getAttribute('href');
    await page.getByRole('button', { name: 'Close' }).click();

    // Convert it AGAIN — the retry that must not duplicate.
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
    const context = await browser.newContext();
    await signIn(context, world().northstar.designer.id);
    const page = await context.newPage();

    await page.goto(channelUrl);
    await expect(page.getByText('Could not load this channel')).toBeVisible();
    // The denial must not carry the source: neither the message nor a composer to reach it.
    await expect(page.getByText(MESSAGE)).toHaveCount(0);
    await expect(page.getByLabel('Message the channel')).toHaveCount(0);

    await context.close();
  });
});
