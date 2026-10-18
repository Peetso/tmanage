import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * PREF-DISPLAY — a member changes their display preferences and the change persists (module 20
 * Preferences & accessibility, x285), through a real browser against the real stack.
 *
 * The `/{orgSlug}/settings/display` hub owns five settings — theme, density, locale, timezone and
 * date format — read and replaced behind `work.read`, scoped by the server to the authenticated
 * principal's own membership (there is no membership in the path). The service's validation and the
 * own-row scoping are proved without a server in `apps/api/src/modules/preferences/*.test.ts`; this
 * journey proves the screen actually carries a member through the loop: the shipped defaults when
 * nothing is saved, a save that confirms, and — the point of the target — that the saved choice
 * survives a full reload and a fresh session on another "device", while a *different* member's row
 * is untouched.
 *
 * The suite is serial because the owner's single membership row is written once (case b) and every
 * later case reads it back; the runner is already `workers: 1, fullyParallel: false`, so this only
 * states the dependency the cases already have. The owner is chosen for the writing chain because no
 * other journey mutates their display preferences; the manager carries the isolation case as a pure
 * reader whose row is never written here.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly manager: SeededUser;
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

/** A fresh browser context (its own cookie jar — a different "device") signed in as `userId`. */
async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await signIn(context, userId);
  const page = await context.newPage();
  return { context, page };
}

const DISPLAY_URL = '/northstar-studio/settings/display';

/** The shipped defaults an unsaved member is reached by (API `DEFAULT_DISPLAY_PREFERENCES`). */
const DEFAULTS = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'UTC',
  dateFormat: 'iso',
} as const;

/** A full non-default choice across every control — nothing left on its default. */
const CHOICE = {
  theme: 'dark',
  density: 'compact',
  locale: 'fr-FR',
  timezone: 'Europe/Paris',
  dateFormat: 'eu',
} as const;

/**
 * Theme and density are radio groups in the redesign (a fieldset per choice, named by its
 * legend); the other three remain selects. A choice is addressed by its stored code.
 */
function themeGroup(page: Page) {
  return page.getByRole('group', { name: 'Theme' });
}
function themeOption(page: Page, value: string) {
  return themeGroup(page).locator(`input[type="radio"][value="${value}"]`);
}
function densityOption(page: Page, value: string) {
  return page
    .getByRole('group', { name: 'Density' })
    .locator(`input[type="radio"][value="${value}"]`);
}
function localeSelect(page: Page) {
  return page.getByLabel('Language & region');
}
function timezoneSelect(page: Page) {
  return page.getByLabel('Timezone');
}
function dateFormatSelect(page: Page) {
  return page.getByLabel('Date format');
}

/** Wait for the form itself, not the loading skeleton: the five controls only render once the
 * server's current settings (or the defaults) have loaded. */
async function waitForForm(page: Page): Promise<void> {
  await expect(themeGroup(page)).toBeVisible();
}

/** Assert every control carries exactly these values, by stored code (option value / radio value). */
async function expectValues(page: Page, values: typeof DEFAULTS | typeof CHOICE): Promise<void> {
  await expect(themeOption(page, values.theme)).toBeChecked();
  await expect(densityOption(page, values.density)).toBeChecked();
  await expect(localeSelect(page)).toHaveValue(values.locale);
  await expect(timezoneSelect(page)).toHaveValue(values.timezone);
  await expect(dateFormatSelect(page)).toHaveValue(values.dateFormat);
}

test.describe.serial('the display-preferences persistence journeys', () => {
  test('E2E-PREF-01a: an unsaved member is shown the shipped defaults', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(DISPLAY_URL);
    await waitForForm(member.page);

    // Never saved, so the screen reads the server's defaults — not a blank form.
    await expectValues(member.page, DEFAULTS);

    await member.context.close();
  });

  test('E2E-PREF-01b: changing every control and saving confirms the save', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(DISPLAY_URL);
    await waitForForm(member.page);

    await themeOption(member.page, CHOICE.theme).check();
    await densityOption(member.page, CHOICE.density).check();
    await localeSelect(member.page).selectOption(CHOICE.locale);
    await timezoneSelect(member.page).selectOption(CHOICE.timezone);
    await dateFormatSelect(member.page).selectOption(CHOICE.dateFormat);

    await member.page.getByRole('button', { name: 'Save preferences' }).click();

    // The success banner only appears after the PUT resolved (`onSuccess`), so its presence is the
    // round-trip, not an optimistic client state.
    await expect(member.page.getByText('Your display preferences have been saved.')).toBeVisible();

    await member.context.close();
  });

  test('E2E-PREF-01c: the saved choice survives a full page reload', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.owner.id);
    await member.page.goto(DISPLAY_URL);
    await waitForForm(member.page);

    // A full reload drops all client state; the form re-seeds from the server's stored row.
    await member.page.reload();
    await waitForForm(member.page);
    await expectValues(member.page, CHOICE);

    await member.context.close();
  });

  test('E2E-PREF-01d: a fresh session on another device reads the saved choice', async ({
    browser,
  }) => {
    // A brand-new context — its own cookie jar, its own QueryClient — is the only way to prove the
    // settings came from the server and not from the tab that saved them.
    const other = await openAs(browser, world().northstar.owner.id);
    await other.page.goto(DISPLAY_URL);
    await waitForForm(other.page);

    await expectValues(other.page, CHOICE);

    await other.context.close();
  });

  test('E2E-PREF-01e: another member is unaffected and still sees the defaults', async ({
    browser,
  }) => {
    // Own-row scoping: the owner saved a full non-default set above; the manager, who never saved,
    // must still read the defaults. If the row were keyed on anything but the acting membership,
    // the manager would inherit the owner's choice here.
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto(DISPLAY_URL);
    await waitForForm(manager.page);

    await expectValues(manager.page, DEFAULTS);

    await manager.context.close();
  });
});
