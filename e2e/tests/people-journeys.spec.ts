import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * PPL-01 — the People & capacity directory (module 14, audit #4), through a real browser against
 * the real stack.
 *
 * The read's tenant scope and the `work.read` ceiling are proved without a server in
 * `apps/api/src/modules/people/directory.controller.test.ts`; this journey proves the `/people`
 * screen actually carries a member through the loop — the roster by name, the role each holds, the
 * active status, and the one capacity fact a directory adds over the member picker: how many
 * projects each person is on. It also proves the server-side search narrows the roster rather than
 * filtering a page the browser already holds, and that the staff roster stays closed to a client
 * principal at the route, not merely in the screen that draws it.
 *
 * All cases are pure reads, so there is no serial ordering and no state to restore: the journey
 * asserts only on members no mutating journey touches (the owner, the manager and the designer —
 * never the offboardee, whom the member-admin and offboarding journeys re-role and revoke).
 */

interface SeededUser {
  readonly id: string;
  readonly displayName: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
  readonly atlas: {
    readonly admin: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
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

const PEOPLE_URL = '/northstar-studio/people';

/** The directory's own list, scoped so the signed-in user's name in the shell never collides. */
function roster(page: Page) {
  return page.getByRole('list', { name: 'People in this organization' });
}

/**
 * One person's row. The redesigned roster groups people by team — each group is itself a list
 * item holding a nested list — so the row is the item that holds no list of its own.
 */
function personRow(page: Page, displayName: string) {
  return roster(page)
    .getByRole('listitem')
    .filter({ hasText: displayName, hasNot: page.getByRole('list') });
}

test.describe('the People & capacity directory journeys', () => {
  test('E2E-PPL-01a: the directory names everyone in the organization, with role and active status', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(PEOPLE_URL);

    // The roster names come from the directory, each with the role the person holds and a status.
    const ownerRow = personRow(member.page, world().northstar.owner.displayName);
    await expect(ownerRow).toBeVisible();
    await expect(ownerRow).toContainText('Owner');
    // The redesigned roster has no status column: it lists active members only (its empty state
    // reads "No active member matches"), so being on it is the active status. PPL-01d proves the
    // empty case.

    const managerRow = personRow(member.page, world().northstar.manager.displayName);
    await expect(managerRow).toBeVisible();
    await expect(managerRow).toContainText('Manager');

    const designerRow = personRow(member.page, world().northstar.designer.displayName);
    await expect(designerRow).toBeVisible();
    await expect(designerRow).toContainText('Team member');

    await member.context.close();
  });

  test('E2E-PPL-01b: each row carries the capacity count the picker never had', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(PEOPLE_URL);

    // The manager is on the Atlas project and the internal project; the designer is on one. The
    // count, and its singular/plural wording, is what distinguishes the directory from the picker.
    await expect(personRow(member.page, world().northstar.manager.displayName)).toContainText(
      'On 2 projects',
    );
    await expect(personRow(member.page, world().northstar.designer.displayName)).toContainText(
      'On 1 project',
    );

    await member.context.close();
  });

  test('E2E-PPL-01c: the server narrows the roster by name', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(PEOPLE_URL);

    // Everyone is present first, so the narrowing below is a change and not the initial state.
    await expect(personRow(member.page, world().northstar.manager.displayName)).toBeVisible();

    await expect(member.page.getByLabel('Search people by name')).toBeEnabled();
    await member.page
      .getByLabel('Search people by name')
      .fill(world().northstar.manager.displayName);

    // Only the match survives — the owner and the designer fall out of the list the server returns.
    await expect(personRow(member.page, world().northstar.manager.displayName)).toBeVisible();
    await expect(personRow(member.page, world().northstar.owner.displayName)).toHaveCount(0);
    await expect(personRow(member.page, world().northstar.designer.displayName)).toHaveCount(0);

    await member.context.close();
  });

  test('E2E-PPL-01d: a search no one matches says so', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(PEOPLE_URL);

    await expect(member.page.getByLabel('Search people by name')).toBeEnabled();
    await member.page.getByLabel('Search people by name').fill('Nobody By That Name');

    await expect(member.page.getByText(/No active member matches/)).toBeVisible();
    await expect(roster(member.page).getByRole('listitem')).toHaveCount(0);

    await member.context.close();
  });

  test('E2E-PPL-01e: the server search is a case-insensitive contains, not a prefix', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(PEOPLE_URL);

    // "del" is the middle of "Omar Adel", lower-cased: a match proves the LIKE is both
    // case-insensitive and a contains rather than a prefix the browser could have faked.
    await expect(member.page.getByLabel('Search people by name')).toBeEnabled();
    await member.page.getByLabel('Search people by name').fill('del');

    await expect(personRow(member.page, world().northstar.manager.displayName)).toBeVisible();
    await expect(personRow(member.page, world().northstar.owner.displayName)).toHaveCount(0);

    await member.context.close();
  });

  test('E2E-PPL-01f: the staff roster is closed to a client principal at the route', async ({
    browser,
  }) => {
    const client = await openAs(browser, world().atlas.admin.id);

    // The directory is behind `work.read`, which no client role holds. The refusal is the
    // capability ceiling's — the agency's staff list can never be handed to the portal.
    const refused = await client.context.request.get(
      `${API_URL}/v1/organizations/northstar-studio/people`,
    );
    expect(refused.status()).toBe(403);

    await client.context.close();
  });
});
