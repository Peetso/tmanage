import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * PPL-01 — the People & capacity directory (module 14, audit #4), through a real browser against
 * the real stack.
 *
 * The read's tenant scope and the `work.read` ceiling are proved without a server in
 * `apps/api/src/modules/people/directory.controller.test.ts`; this journey proves the `/people`
 * screen actually carries a member through the loop — the roster by name, the role each holds, the
 * active status, and the one capacity fact a directory adds over the member picker: how many
 * projects each person is on. It also proves that the staff roster stays closed to a client
 * principal at the route, not merely in the screen that draws it.
 *
 * A1 rebuilt the screen to Members and roles (Figma 374:1985, r-people): a table, no search box
 * (the server search stays proved in `directory.controller.test.ts`). The read cases assert only on
 * members no mutating journey touches (the owner, the manager and the designer — never the
 * offboardee, whom the member-admin and offboarding journeys re-role and revoke). E2E-PPL-02 is the
 * one write: it changes the designer's organization role and changes it back before it ends, and
 * runs last in the file (the suite runs one worker, in order). E2E-PPL-03 (H1, audit 2026-10-26
 * gap 3) follows it on the same terms: it gives the designer a custom role and restores Member.
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

/** The CSRF header pair the API's guard wants on a write (the app's fetch client sends the same). */
async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const csrf = (await context.cookies(API_URL)).find(
    (cookie) => cookie.name === 'tmanage_session_csrf',
  );
  expect(csrf?.value).toBeTruthy();
  return { 'x-csrf-token': csrf?.value as string, origin: WEB_URL };
}

const PEOPLE_URL = '/northstar-studio/people';

/** The roster table, scoped so the signed-in user's name in the shell never collides. */
function roster(page: Page) {
  return page.getByRole('table', { name: 'People in this organization' });
}

/** One person's row of the Members and roles table. */
function personRow(page: Page, displayName: string) {
  return roster(page).getByRole('row').filter({ hasText: displayName });
}

/** Open Change role from the row's role chip, pick `label`, confirm, and wait for the new chip. */
async function changeRole(page: Page, displayName: string, from: string, label: string) {
  await page.getByRole('button', { name: `Role of ${displayName}: ${from}. Change role` }).click();
  const dialog = page.getByRole('dialog', { name: 'Change role' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: new RegExp(`^${label}`) }).check();
  await dialog.getByRole('button', { name: `Change to ${label}` }).click();
  await expect(dialog).toHaveCount(0);
  await expect(personRow(page, displayName)).toContainText(label);
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
    await expect(designerRow).toContainText('Member');

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
      '2 projects',
    );
    await expect(personRow(member.page, world().northstar.designer.displayName)).toContainText(
      '1 project',
    );

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

  test('E2E-PPL-02: an owner changes a member role from Members and roles', async ({ browser }) => {
    const owner = await openAs(browser, world().northstar.owner.id);
    const designer = world().northstar.designer.displayName;
    await owner.page.goto(PEOPLE_URL);
    await expect(personRow(owner.page, designer)).toContainText('Member');

    try {
      await changeRole(owner.page, designer, 'Member', 'Manager');
      // The change is the server's: a fresh read of the roster still says Manager.
      await owner.page.reload();
      await expect(personRow(owner.page, designer)).toContainText('Manager');
    } finally {
      // Restore the seed so the journeys that sign in as the designer see her role unchanged.
      await owner.page.goto(PEOPLE_URL);
      const row = personRow(owner.page, designer);
      await expect(row).toBeVisible();
      if (!((await row.textContent()) ?? '').includes('Member')) {
        await changeRole(owner.page, designer, 'Manager', 'Member');
      }
      await owner.context.close();
    }
  });

  test('E2E-PPL-03: a member given a custom role opens the company and sees the nav that role allows', async ({
    browser,
  }) => {
    const designer = world().northstar.designer;
    // A fresh name each run: a custom role is never deleted, and a duplicate name is a 409.
    const roleName = `Studio lead ${Date.now().toString(36)}`;
    const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary', exact: true });

    // Before: as a plain Member the designer is offered no Control Center.
    const before = await openAs(browser, designer.id);
    await before.page.goto('/northstar-studio/home');
    await expect(rail(before.page).getByRole('link', { name: 'Chat' })).toBeVisible();
    await expect(rail(before.page).getByRole('link', { name: 'My Day' })).toBeVisible();
    await expect(rail(before.page).getByRole('link', { name: 'Control' })).toHaveCount(0);
    await before.context.close();

    const owner = await openAs(browser, world().northstar.owner.id);
    try {
      // The owner defines the role in Control > Roles' API: chat, work and the admin right.
      const created = await owner.context.request.post(
        `${API_URL}/v1/organizations/northstar-studio/admin/roles`,
        {
          headers: await csrfHeaders(owner.context),
          data: {
            name: roleName,
            capabilities: [
              'conversation.read',
              'conversation.write',
              'work.read',
              'client_projection.read',
              'org.manage',
            ],
          },
        },
      );
      expect(created.status(), await created.text()).toBe(201);

      // ...and gives it to the designer from Members and roles, the custom-role group of Change role.
      await owner.page.goto(PEOPLE_URL);
      await changeRole(owner.page, designer.displayName, 'Member', roleName);
      await owner.page.reload();
      await expect(personRow(owner.page, designer.displayName)).toContainText(roleName);

      // After: she signs in fresh, opens the company, and the rail carries what her role allows —
      // the everyday destinations and, because the role holds org.manage, the Control Center.
      const member = await openAs(browser, designer.id);
      try {
        await member.page.goto('/northstar-studio/home');
        const nav = rail(member.page);
        await expect(nav.getByRole('link', { name: 'Chat' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Work' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'People' })).toBeVisible();
        const control = nav.getByRole('link', { name: 'Control' });
        await expect(control).toBeVisible();
        await expect(control).toHaveAttribute('href', '/northstar-studio/admin');

        // Chat opens for her: the role's conversation.read is honoured past the rail.
        await nav.getByRole('link', { name: 'Chat' }).click();
        await expect(member.page).toHaveURL(/\/northstar-studio\/chat/);

        // People names her role by its own name, to her as well as to the owner.
        await member.page.goto(PEOPLE_URL);
        await expect(personRow(member.page, designer.displayName)).toContainText(roleName);
      } finally {
        await member.context.close();
      }
    } finally {
      // Restore the seed so the journeys that sign in as the designer see her role unchanged.
      await owner.page.goto(PEOPLE_URL);
      const row = personRow(owner.page, designer.displayName);
      await expect(row).toBeVisible();
      if (((await row.textContent()) ?? '').includes(roleName)) {
        await changeRole(owner.page, designer.displayName, roleName, 'Member');
      }
      await owner.context.close();
    }
  });
});
