import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * TEST-003's calendar journey, through a real browser against the real stack.
 *
 * - **E2E — module 9, "Schedule a meeting → see it listed → open its notes"** — the whole path a
 *   person walks to earn module 9's credit: open Calendar, choose a project, schedule a meeting,
 *   see it appear in that project's list, and follow it into its notes page. x90 landed the API and
 *   x105/x108 the notes read screen; until x122 the `/calendar` route was a `PlannedInternalScreen`
 *   stub with no UI and no journey (audit Top-10 #8). This is the first time the create→list→detail
 *   path is watched from the outside.
 * - **E2E — module 9b, "Edit a meeting and add an attendee"** (A5) — open a meeting's detail, edit
 *   its end time, add a team member from "+ Add people", save, and see the toast and the saved
 *   card with the new time and the invited attendee.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly designer: SeededUser & { readonly displayName: string };
    readonly projectName: string;
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

const MEETING_TITLE = 'E2E planning sync';

test('module 9: schedule a meeting, see it listed, open its notes', async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, world().northstar.owner.id);
  const page = await context.newPage();

  await page.goto('/northstar-studio/calendar');

  // Choose the project. Wait for the projects query to fill its options before selecting.
  await expect(page.getByRole('option', { name: world().northstar.projectName })).toBeAttached();
  await page
    .getByLabel('Show the meetings for')
    .selectOption({ label: world().northstar.projectName });

  // Schedule a meeting in that project.
  await page.getByLabel('Title').fill(MEETING_TITLE);
  await page.getByLabel('Starts').fill('2026-10-01T14:00');
  await page.getByRole('button', { name: 'Schedule meeting' }).click();

  // It appears in the project's list, as a link into its detail page.
  const link = page.getByRole('link', { name: MEETING_TITLE });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/northstar-studio\/calendar\/meetings\/[0-9a-f-]+$/);

  // Follow it into the meeting's detail, then its Notes page — a brand-new meeting has none yet.
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: MEETING_TITLE })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'This meeting' })
    .getByRole('link', { name: 'Notes' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Meeting notes' })).toBeVisible();
  await expect(page.getByText('No notes yet')).toBeVisible();

  await context.close();
});

const EDITED_TITLE = 'E2E edit sync';

test('module 9b: edit a meeting and add an attendee', async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, world().northstar.owner.id);
  const page = await context.newPage();

  // Schedule the meeting to edit (the module 9 path), then open its detail.
  await page.goto('/northstar-studio/calendar');
  await expect(page.getByRole('option', { name: world().northstar.projectName })).toBeAttached();
  await page
    .getByLabel('Show the meetings for')
    .selectOption({ label: world().northstar.projectName });
  await page.getByLabel('Title').fill(EDITED_TITLE);
  await page.getByLabel('Starts').fill('2026-10-29T14:00');
  await page.getByRole('button', { name: 'Schedule meeting' }).click();
  await page.getByRole('link', { name: EDITED_TITLE }).click();
  await expect(page.getByRole('heading', { level: 1, name: EDITED_TITLE })).toBeVisible();

  // Edit: give it an end, and add a team member from "+ Add people".
  await page.getByRole('button', { name: 'Edit meeting' }).click();
  const form = page.getByRole('form', { name: 'Edit meeting' });
  await form.getByLabel('Ends').fill('15:00');
  await form.getByRole('button', { name: '+ Add people' }).click();
  const picker = page.getByRole('dialog', { name: 'Add people' });
  const designer = world().northstar.designer.displayName;
  await picker.getByLabel('Find people').fill(designer);
  await picker.getByRole('button', { name: new RegExp(designer) }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();

  // Saved: the toast, the new time, and the new attendee invited.
  await expect(page.getByText('Meeting saved')).toBeVisible();
  const card = page.getByRole('region', { name: 'Meeting details' });
  await expect(card.getByText('14:00 – 15:00')).toBeVisible();
  const row = card.getByRole('listitem').filter({ hasText: designer });
  await expect(row.getByText('Invited')).toBeVisible();

  await context.close();
});
