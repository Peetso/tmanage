import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * TEST-003's calendar journey, through a real browser against the real stack.
 *
 * - **E2E — module 9, "Schedule a meeting → open it → open its notes"** — New meeting from All
 *   meetings (approved Figma 417:9827), pick the project, save, land on the meeting page
 *   (418:10146), then follow the Notes tab. No calendar is connected in the stack, so the meeting
 *   stays in TManage.
 * - **E2E — module 9b, "Edit a meeting and add a guest"** — Edit from the meeting page, change the
 *   end time, add a team member from "Add guests", save, and see them on the meeting page.
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

async function scheduleMeeting(page: Page, title: string, date: string): Promise<void> {
  await page.goto('/northstar-studio/calendar');
  await page.getByRole('link', { name: 'New meeting' }).first().click();
  await expect(page).toHaveURL(/\/calendar\/new/);
  await expect(page.getByRole('option', { name: world().northstar.projectName })).toBeAttached();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Date', { exact: true }).fill(date);
  await page
    .getByLabel('Project', { exact: true })
    .selectOption({ label: world().northstar.projectName });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/meetings\/[0-9a-f-]+\?saved=1$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeAttached();
}

const MEETING_TITLE = 'E2E planning sync';

test('module 9: schedule a meeting, open it, open its notes', async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, world().northstar.owner.id);
  const page = await context.newPage();

  await scheduleMeeting(page, MEETING_TITLE, '2026-10-01');
  await expect(page.getByText('Saved in TManage.')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Meeting sections' })
    .getByRole('link', { name: 'Notes' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Meeting notes' })).toBeVisible();

  await context.close();
});

const EDITED_TITLE = 'E2E edit sync';

test('module 9b: edit a meeting and add a guest', async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, world().northstar.owner.id);
  const page = await context.newPage();

  await scheduleMeeting(page, EDITED_TITLE, '2026-10-29');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByLabel('Ends').fill('15:00');
  const designer = world().northstar.designer.displayName;
  await page.getByLabel('Add guests').fill(designer);
  await page
    .getByRole('button', { name: new RegExp(designer) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page).toHaveURL(/\?saved=1$/);
  const guests = page.getByRole('region', { name: /Guests/ });
  await expect(guests.getByText(designer)).toBeVisible();

  await context.close();
});
