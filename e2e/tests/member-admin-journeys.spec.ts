import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * ADM-02 — project member and role administration, through a real browser against the real stack.
 *
 * The API's guards (assign above ceiling, self role change, last owner) are proved exhaustively in
 * `apps/api/src/modules/projects/project-members.controller.test.ts`; this journey proves the
 * screen and the routes actually carry an administrator through the loop, and that one refusal —
 * a manager changing their own project role — reaches the person as a message rather than a silent
 * no-op.
 *
 * Fresh stack per run (`globalSetup`), `retries: 0`: the loop adds and removes rows and does not
 * put them back, so a serial retry would replay against a roster that has already moved.
 */

interface SeededUser {
  readonly id: string;
  readonly displayName: string;
}

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
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

function membersUrl(projectId: string): string {
  return `/northstar-studio/projects/${projectId}/members`;
}

test.describe.serial('the project member-admin journeys', () => {
  test('E2E-ADM-02a: an owner adds, re-roles and removes a project member', async ({ browser }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(membersUrl(world().northstar.projectId));

    // The roster names come from the directory, not from raw ids.
    await expect(admin.page.getByText(world().northstar.manager.displayName)).toBeVisible();
    await expect(admin.page.getByText(world().northstar.designer.displayName)).toBeVisible();

    // Re-role the designer, a compare-and-swap on their current role.
    await admin.page
      .getByLabel(`Role for ${world().northstar.designer.displayName}`)
      .selectOption({ label: 'Manager' });
    const designerRow = admin.page
      .getByRole('listitem')
      .filter({ hasText: world().northstar.designer.displayName });
    await expect(designerRow).toContainText('Manager');

    // Add the owner (org-wide, but not yet a member of this project) to the project.
    await admin.page
      .getByLabel('Person')
      .selectOption({ label: world().northstar.owner.displayName });
    await admin.page.getByLabel('Role', { exact: true }).selectOption({ label: 'Team member' });
    await admin.page.getByRole('button', { name: 'Add to project' }).click();
    await expect(
      admin.page.getByRole('listitem').filter({ hasText: world().northstar.owner.displayName }),
    ).toBeVisible();

    // Remove the designer again; the loop leaves the roster changed on purpose.
    await designerRow.getByRole('button', { name: 'Remove' }).click();
    await expect(
      admin.page.getByRole('listitem').filter({ hasText: world().northstar.designer.displayName }),
    ).toHaveCount(0);
  });

  test('E2E-ADM-02b: a manager changing their own role is refused, with a message', async ({
    browser,
  }) => {
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto(membersUrl(world().northstar.projectId));

    await expect(manager.page.getByText(world().northstar.manager.displayName)).toBeVisible();
    await manager.page
      .getByLabel(`Role for ${world().northstar.manager.displayName}`)
      .selectOption({ label: 'Workspace admin' });

    // The API refuses a self role change (403); the screen surfaces it rather than swallowing it.
    await expect(manager.page.getByText('That change was refused')).toBeVisible();
  });
});
