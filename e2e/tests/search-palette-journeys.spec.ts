import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * SRCH command palette (x181) + global search (x111), walked through a real browser against the
 * real stack — the keyboard surface the screen tests mount in isolation, seen end to end for the
 * first time.
 *
 * The palette is mounted by {@link AppShell} on every internal screen and renders nothing until
 * Ctrl/Cmd-K opens it. These journeys cover the behaviours a person actually leans on:
 *
 * - **PALETTE-OPEN** — Ctrl/Cmd-K opens the focus-trapped dialog, Escape closes it, and a second
 *   Ctrl/Cmd-K toggles it shut.
 * - **PALETTE-DEFAULT** — with no query the palette offers the default command set (create
 *   commands and the rail mirror under "Go to") and neither a search-for row nor a recent-search
 *   row.
 * - **PALETTE-NAVIGATE** — typing filters to a navigate command, and activating it by click takes
 *   the caller to that tenant-scoped screen.
 * - **PALETTE-KEYBOARD** — the best match is the active row, the arrows move it, and Enter
 *   activates it, with no mouse.
 * - **PALETTE-SEARCH** — the "search the workspace for …" row hands the query to the real results
 *   screen, seeds the per-organization recent search, and the clear-recent quick action forgets it.
 *
 * A *hit* is deliberately not asserted. The e2e harness migrates before it seeds, and `search_index`
 * is populated only by migration 0054's backfill — live-on-write indexing is deferred (NS-13) and
 * `SearchIndexer` is wired to no source write. So the index is empty for every raw-SQL-seeded row,
 * and global search returns "no matches" for all seeded data in this harness. The palette
 * behaviours under test — the search handoff, the per-organization recent-search memory, and the
 * clear-recent quick action — are all independent of whether the results page has a hit.
 *
 * Signed in as the designer (Lina), who is a member of the Atlas project, so every navigate target
 * resolves tenant-scoped.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly designer: SeededUser;
  };
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

const ORG = 'northstar-studio';

/** Sign in as the designer and open the home screen, where the palette is mounted but closed. */
async function openHome(context: BrowserContext): Promise<Page> {
  await signIn(context, world().northstar.designer.id);
  const page = await context.newPage();
  await page.goto(`/${ORG}/home`);
  // The shell is up once its primary navigation has rendered.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

/** Open the palette with the keyboard and return its dialog locator, with the combobox focused. */
async function openPalette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  // The shell attaches the Ctrl/Cmd-K handler in an effect after hydration; immediately after a
  // cold navigation the very first chord can land before the listener exists and is then lost (a
  // dropped keypress is not redelivered). Press only while the dialog is still absent — a
  // condition-driven retry, never a tuned sleep, and never a blind re-press that would toggle an
  // already-open palette shut.
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await page.keyboard.press('Control+KeyK');
    }
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(dialog.getByRole('combobox')).toBeFocused();
  return dialog;
}

test('PALETTE-OPEN: Ctrl-K opens the palette, Escape closes it, and Ctrl-K toggles it shut', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openHome(context);

  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toHaveCount(0);

  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Re-open, then toggle shut with the same chord.
  await openPalette(page);
  await page.keyboard.press('Control+KeyK');
  await expect(dialog).toHaveCount(0);

  await context.close();
});

test('PALETTE-DEFAULT: an empty query offers the default command set and no search/recent rows', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openHome(context);

  const dialog = await openPalette(page);

  // The rail-mirroring "Go to" destinations and a create command are all offered up front.
  const goTo = dialog.getByRole('group', { name: 'Go to' });
  await expect(goTo.getByRole('option', { name: /^My Day/u })).toBeVisible();
  await expect(goTo.getByRole('option', { name: /^Work/u })).toBeVisible();
  await expect(dialog.getByRole('option', { name: /^New task/u })).toBeVisible();

  // With no query there is neither a "search for …" seed row nor a recent-search row.
  await expect(dialog.getByRole('option', { name: /Search the workspace for/ })).toHaveCount(0);
  await expect(dialog.getByRole('option', { name: /Recent search:/ })).toHaveCount(0);

  await context.close();
});

test('PALETTE-NAVIGATE: typing filters to a navigate command, and a click goes to its screen', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openHome(context);

  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('inbox');

  const option = dialog
    .getByRole('group', { name: 'Go to' })
    .getByRole('option', { name: 'Inbox' });
  await expect(option).toBeVisible();
  await option.click();

  await page.waitForURL(`**/${ORG}/inbox`);
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  // Activation closes the palette.
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);

  await context.close();
});

test('PALETTE-KEYBOARD: ArrowDown selects a command and Enter activates it, no mouse', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openHome(context);

  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('calendar');

  // The whole-label match ranks first and is the active row; ArrowDown moves off it (to the
  // "search for …" row) and ArrowUp comes back, all on the keyboard.
  const command = dialog
    .getByRole('group', { name: 'Go to' })
    .getByRole('option', { name: 'Calendar' });
  await expect(command).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(command).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowUp');
  await expect(command).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await page.waitForURL(`**/${ORG}/calendar`);

  await context.close();
});

test('PALETTE-SEARCH: searching the workspace reaches the results screen, seeds the recent search, and clearing forgets it', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openHome(context);

  // Search the workspace through the palette's seed row.
  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('booking');
  await dialog.getByRole('option', { name: /Search the workspace for/ }).click();

  await page.waitForURL(`**/${ORG}/search?q=booking`);
  // The palette handed the query to the real results screen: the search page renders with the
  // query reflected. A hit is not asserted — the harness's index is empty for seeded rows (see the
  // suite note above), so this is the real, observable result of the handoff.
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveValue('booking');

  // Re-opening the palette now offers the recent search — persisted per organization in storage.
  const dialogAgain = await openPalette(page);
  const recent = dialogAgain.getByRole('option', { name: 'Recent search: booking' });
  await expect(recent).toBeVisible();

  // The clear-recent quick action forgets it in place, without leaving the palette.
  await dialogAgain.getByRole('combobox').fill('clear');
  await dialogAgain.getByRole('option', { name: 'Clear recent search' }).click();
  await expect(dialogAgain.getByRole('option', { name: /Recent search:/ })).toHaveCount(0);
  // The palette itself is still open — clearing is a quick action, not a navigation.
  await expect(dialogAgain).toBeVisible();

  await context.close();
});
