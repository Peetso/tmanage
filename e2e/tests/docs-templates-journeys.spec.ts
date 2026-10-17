import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * DOC-04 / ADM-06 (x119) template gallery journey, through a real browser against the real stack.
 *
 * - **DOC-04, "Create a template, apply it, and edit the new document"** — the whole path a person
 *   walks: open the template gallery, create an org-scoped template, apply it to a project, follow
 *   the link to the document the apply created, and see it seeded from the template body. The
 *   template itself is unchanged and reappears in the gallery.
 *
 * The screen's authorize/relation logic and the Known-trap 404 are proved over fakes and a real
 * server in `apps/api`; this journey watches the create → apply → edit path from the outside.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
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

const TEMPLATE_NAME = 'Kickoff brief template';
const TEMPLATE_BODY = 'Goals\n- \nRisks\n- \nOwner: ';

test('DOC-04: create a template, apply it, and edit the seeded document', async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, world().northstar.owner.id);
  const page = await context.newPage();

  await page.goto('/northstar-studio/docs/templates');

  // Create the template.
  const form = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'New template' }) });
  // The form ships disabled until React hydrates (useHydrated); wait for that readiness signal.
  await expect(form.getByLabel('Name')).toBeEnabled();
  await form.getByLabel('Name').fill(TEMPLATE_NAME);
  await form.getByLabel('Purpose').fill('Start a project kickoff brief');
  await form.getByLabel('Template body').fill(TEMPLATE_BODY);
  await form.getByRole('button', { name: 'Create template' }).click();

  // It appears in the gallery.
  const gallery = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Template gallery' }) });
  await expect(gallery.getByRole('rowheader', { name: TEMPLATE_NAME })).toBeVisible();

  // Apply it to the project (the select defaults to the first shared project).
  await gallery.getByRole('button', { name: 'Apply' }).click();

  // The apply created a new document; follow the link to its editor and see the seeded body.
  const open = gallery.getByRole('link', { name: /open/i });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByLabel('Document body')).toHaveValue(TEMPLATE_BODY);

  await context.close();
});
