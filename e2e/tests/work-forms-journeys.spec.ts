import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * The work-item detail page's two append surfaces — the checklist (x145) and the comments /
 * activity trail (x147) — through a real browser against the real stack.
 *
 * `work-journeys.spec.ts` drives the state machine on the Northstar seed item; this file leaves
 * the item's state untouched and exercises the sub-resources mounted beside it
 * (`WorkChecklistPanel`, `WorkCommentsPanel`). Both panels read their own query and invalidate it
 * on every write, so the standing claim is not "the input echoed back" but "the server kept it":
 * every leg here reloads or opens a *second member's* browser and reads the same fact back.
 *
 * ## Why this is safe to run against the Northstar item
 *
 * The checklist and the comments live in their own tables (`work_item_checklist_items`,
 * `work_item_comments`) and neither write bumps `work_items.version` or its state. So this file
 * neither depends on nor disturbs the serial state journey in `work-journeys.spec.ts`, whichever
 * order the single worker runs the two files in, and the seed ships this item with an empty
 * checklist and no comments (`seed-two-tenants.ts` writes neither), which is what the empty-state
 * legs assert against.
 *
 * ## Serial on purpose
 *
 * The legs build on one another — `a` reads the empty state before `b` fills it, `b`'s toggle is
 * the fact `d` reads from a different browser — so they are a `describe.serial`, and `retries`
 * is already 0 (a replay of `b` against an item that already has the sub-items would double them).
 */

interface SeededUser {
  readonly id: string;
  readonly displayName: string;
}

interface World {
  readonly northstar: {
    readonly workItemId: string;
    readonly designer: SeededUser;
    readonly manager: SeededUser;
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

async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await signIn(context, userId);
  const page = await context.newPage();
  return { context, page };
}

function workUrl(organizationSlug: string, workItemId: string): string {
  return `/${organizationSlug}/work/${workItemId}`;
}

// Distinctive strings so a stray match in another panel cannot satisfy these assertions, and so a
// human reading the trace can tell this journey's rows from the seed's.
const FIRST_SUBITEM = 'Collect the booking-provider sandbox credentials';
const SECOND_SUBITEM = 'Wire the sandbox credentials into the staging config';
const FIRST_COMMENT = 'Kicked this off; waiting on Atlas for the sandbox key.';
const SECOND_COMMENT = 'Atlas replied — key should land before standup tomorrow.';

test.describe.serial('the work-item checklist and comments', () => {
  test('WORK-FORMS-a: the checklist starts empty and its add form refuses a blank label', async ({
    browser,
  }) => {
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));

    // `exact` because `getByRole`'s name is a substring match and "Activity" is a sibling region;
    // "Checklist" alone would also match nothing else, but the habit keeps the two panels apart.
    const checklist = maker.page.getByRole('region', { name: 'Checklist', exact: true });
    await expect(checklist).toContainText('No sub-items yet. Add the first one below.');

    // The form's own guard, before the server is ever asked: the submit is disabled while the
    // field is empty, and a field of only whitespace is empty to it (`label.trim() === ''`). This
    // is the client half of the non-empty rule the controller enforces with a 400.
    const addButton = checklist.getByRole('button', { name: 'Add sub-item' });
    await expect(addButton).toBeDisabled();
    await checklist.getByLabel('Add a checklist item').fill('   ');
    await expect(addButton).toBeDisabled();

    await maker.context.close();
  });

  test('WORK-FORMS-b: a sub-item is added, counted, toggled done, and survives a reload', async ({
    browser,
  }) => {
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));
    const checklist = maker.page.getByRole('region', { name: 'Checklist', exact: true });

    await checklist.getByLabel('Add a checklist item').fill(FIRST_SUBITEM);
    await checklist.getByRole('button', { name: 'Add sub-item' }).click();

    // The count sentence is the panel's running total, and the field clears for the next add.
    await expect(checklist).toContainText('0 of 1 done.');
    await expect(checklist.getByLabel('Add a checklist item')).toHaveValue('');

    await checklist.getByLabel('Add a checklist item').fill(SECOND_SUBITEM);
    await checklist.getByRole('button', { name: 'Add sub-item' }).click();
    await expect(checklist).toContainText('0 of 2 done.');

    // Order is the add order — the controller appends, the panel renders in order. Read off the
    // checkboxes themselves so the claim is about the list the person operates, not the DOM around
    // it.
    const boxes = checklist.getByRole('list', { name: 'Checklist items' }).getByRole('checkbox');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).toHaveAccessibleName(FIRST_SUBITEM);
    await expect(boxes.nth(1)).toHaveAccessibleName(SECOND_SUBITEM);
    await expect(boxes.nth(0)).not.toBeChecked();

    // Toggle the first done — `click`, not `check`: the box is a controlled input whose
    // `checked` follows the server (`item.done`), and the toggle is an async mutation that
    // invalidates the query. React reverts the native tick to `false` until the refetch lands, so
    // `check`'s own "did it flip?" guard would race it. The `toBeChecked` below is the real
    // claim, and it retries until the round-trip finishes.
    await checklist.getByRole('checkbox', { name: FIRST_SUBITEM }).click();
    await expect(checklist).toContainText('1 of 2 done.');
    await expect(checklist.getByRole('checkbox', { name: FIRST_SUBITEM })).toBeChecked();
    await expect(checklist.getByRole('checkbox', { name: SECOND_SUBITEM })).not.toBeChecked();

    // The fact is the server's, not the tab's: a reload refetches and reads the same state back.
    await maker.page.reload();
    const afterReload = maker.page.getByRole('region', { name: 'Checklist', exact: true });
    await expect(afterReload).toContainText('1 of 2 done.');
    await expect(afterReload.getByRole('checkbox', { name: FIRST_SUBITEM })).toBeChecked();
    await expect(afterReload.getByRole('checkbox', { name: SECOND_SUBITEM })).not.toBeChecked();

    await maker.context.close();
  });

  test('WORK-FORMS-c: comments start empty and append oldest-first', async ({ browser }) => {
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));
    const activity = maker.page.getByRole('region', { name: 'Activity', exact: true });
    await expect(activity).toContainText('No comments yet. Ask a question or share an update.');

    await activity.getByLabel('Add a comment').fill(FIRST_COMMENT);
    await activity.getByRole('button', { name: 'Add comment' }).click();
    await expect(activity.getByText(FIRST_COMMENT)).toBeVisible();
    // The box clears and its submit disables again — the append-only form resets for the next note.
    await expect(activity.getByLabel('Add a comment')).toHaveValue('');
    await expect(activity.getByRole('button', { name: 'Add comment' })).toBeDisabled();

    await activity.getByLabel('Add a comment').fill(SECOND_COMMENT);
    await activity.getByRole('button', { name: 'Add comment' }).click();
    await expect(activity.getByText(SECOND_COMMENT)).toBeVisible();

    // Oldest-first: the first note authored is the first list item, the second is the second. The
    // panel documents this ordering, so the journey pins it rather than trusting it.
    const entries = activity.getByRole('list', { name: 'Comments' }).getByRole('listitem');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText(FIRST_COMMENT);
    await expect(entries.nth(1)).toContainText(SECOND_COMMENT);

    await maker.context.close();
  });

  test('WORK-FORMS-d: a second member reads the same checklist and comments back', async ({
    browser,
  }) => {
    // The whole point of invalidating the query on write rather than keeping optimistic state: a
    // different person, who never typed any of this, opens the item and finds exactly what the
    // maker left — the checklist at one-of-two done, both comments oldest-first. Comments are
    // internal, and the manager is a studio member, so they are visible to them.
    const reader = await openAs(browser, world().northstar.manager.id);
    await reader.page.goto(workUrl('northstar-studio', world().northstar.workItemId));

    const checklist = reader.page.getByRole('region', { name: 'Checklist', exact: true });
    await expect(checklist).toContainText('1 of 2 done.');
    await expect(checklist.getByRole('checkbox', { name: FIRST_SUBITEM })).toBeChecked();
    await expect(checklist.getByRole('checkbox', { name: SECOND_SUBITEM })).not.toBeChecked();

    const activity = reader.page.getByRole('region', { name: 'Activity', exact: true });
    const entries = activity.getByRole('list', { name: 'Comments' }).getByRole('listitem');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText(FIRST_COMMENT);
    await expect(entries.nth(1)).toContainText(SECOND_COMMENT);

    await reader.context.close();
  });
});
