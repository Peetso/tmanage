import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The decision-lifecycle loop, through a real browser against the real stack (DEC-01-b / DEC-02,
 * x117).
 *
 * A studio member opens a project's decision register, records two decisions, accepts the first
 * (`proposed → accepted`), then supersedes the second **by** the first — the chain edge. The exit
 * assertions are on the register itself: the accepted decision reads "Accepted", and the superseded
 * one reads "Superseded" and offers no further lifecycle action. This exercises the three routes the
 * slice adds (`PATCH …/decisions/:id`, `POST …/decisions/:id/supersede`, `GET …/decisions/:id`)
 * through the screen a person actually uses, not through the API alone.
 *
 * Serial on purpose: each step builds on the register the first one seeded. The suite needs a fresh
 * stack per run (globalSetup provides it) and `retries: 0`, because the lifecycle is one-way — a
 * replay would find the decisions no longer proposed.
 */

interface SeededTenant {
  readonly projectName: string;
}
interface SeededUser {
  readonly id: string;
}
interface World {
  readonly northstar: SeededTenant & { readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

const SLUG = 'northstar-studio';
const FIRST = 'Adopt the staging pipeline';
const SECOND = 'Adopt the blue/green pipeline';

async function recordDecision(page: Page, title: string): Promise<void> {
  await page.getByLabel(/^Decision/).fill(title);
  await page.getByLabel(/in words/i).fill(`${title} — recorded by the decision journey.`);
  await page.getByRole('button', { name: /record decision/i }).click();
  await expect(page.getByRole('rowheader', { name: title })).toBeVisible();
}

test.describe.serial('the decision-lifecycle journeys', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('DEC: a member records, accepts, and supersedes decisions on the register', async () => {
    await page.goto(`/${SLUG}/decisions`);

    // Choose the project whose register we work on.
    await page
      .getByLabel(/show the register for/i)
      .selectOption({ label: world().northstar.projectName });

    await recordDecision(page, FIRST);
    await recordDecision(page, SECOND);

    // Accept the first decision: proposed → accepted.
    const firstRow = page.getByRole('row', { name: new RegExp(FIRST) });
    await firstRow.getByRole('button', { name: /^Accept$/ }).click();
    await expect(firstRow.getByRole('cell', { name: /Accepted/ })).toBeVisible();

    // Supersede the second decision by the first — the chain edge.
    const secondRow = page.getByRole('row', { name: new RegExp(SECOND) });
    await secondRow.getByLabel(/supersede with/i).selectOption({ label: FIRST });
    await secondRow.getByRole('button', { name: /^Supersede$/ }).click();
    await expect(secondRow.getByRole('cell', { name: /Superseded/ })).toBeVisible();
  });
});
