import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * platform-admin v2 · PA-06 — People (B1–B4) through a real browser against the real stack.
 *
 * The operator (`world().platformAdmin`, the bootstrap super admin) browses everyone, filters by
 * an organization, opens a person and changes their email (the notice, then a 409 on a taken
 * address, then the original address back), ends one session, resets two-step with a reason,
 * disables an account with a reason — the right password is then refused with the same neutral
 * answer as a wrong one — and enables it again. The Arabic list renders right-to-left.
 *
 * Every change is undone before the journey ends, because later specs reuse the same accounts:
 * BrightOps' owner (no password; the email, session and two-step steps) and the support
 * candidate (has a password; the disable / sign-in step — still enabled and without a factor
 * when the team journeys add them).
 *
 * Fresh stack per run, one worker, serial.
 */

interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly supportCandidate: PlatformUser;
  readonly northstar: { readonly organizationId: string; readonly owner: SeededUser };
  readonly brightops: { readonly organizationId: string; readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page; csrf: string }> {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const page = await context.newPage();
  return { context, page, csrf: csrfToken };
}

/** The Platform admin step-up: password only (neither seeded platform account has a factor). */
async function stepUp(page: Page, password: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('platform-step-up-pill')).toContainText('Step-up valid');
}

async function openAdmin(browser: Browser, path: string) {
  const admin = await openAs(browser, world().platformAdmin.id);
  await admin.page.goto(path);
  await stepUp(admin.page, world().platformAdmin.password);
  return admin;
}

/** A password sign-in from our own pages (F43: same origin), as the sign-in form sends it. */
async function passwordSignIn(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const response = await context.request.post(`${API_URL}/v1/auth/password`, {
    headers: { origin: WEB_URL },
    data: { email, password },
  });
  const status = response.status();
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  await context.close();
  return { status, message: body.error?.message ?? '' };
}

async function confirmReason(page: Page, reason: string, confirm: string | RegExp) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Reason \(required/u).fill(reason);
  await dialog.getByRole('button', { name: confirm }).click();
  await expect(dialog).toBeHidden();
}

test.describe.serial('the platform people journeys', () => {
  test('E2E-PA06-01: browse all, then filter by an organization and open a person', async ({
    browser,
  }) => {
    const { context, page } = await openAdmin(browser, '/platform/people');
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse all' }).click();
    const table = page.getByRole('table', { name: 'People' });
    await expect(table.getByText(world().northstar.owner.displayName)).toBeVisible();

    await page
      .getByRole('combobox', { name: /Organization/u })
      .selectOption(world().brightops.organizationId);
    await expect(table.getByText(world().brightops.owner.displayName)).toBeVisible();
    await expect(table.getByText(world().northstar.owner.displayName)).toHaveCount(0);

    await table.getByRole('link', { name: world().brightops.owner.displayName }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: world().brightops.owner.displayName }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Account facts' })).toBeVisible();
    await context.close();
  });

  test('E2E-PA06-02: change the email — the notice, a 409 on a taken one, then back', async ({
    browser,
  }) => {
    const target = world().brightops.owner;
    const { context, page } = await openAdmin(browser, `/platform/people/${target.id}`);
    const email = page.getByLabel('Email', { exact: true });

    await email.fill('owner.renamed@brightops.test');
    await expect(page.getByText(/Saving a new email ends all of/u)).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByText(/Every session ended and a verification link went to/u),
    ).toBeVisible();

    await email.fill(world().northstar.owner.email);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/already belongs to another account \(409\)/u)).toBeVisible();

    await email.fill(target.email);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/Every session ended/u)).toBeVisible();
    await context.close();
  });

  test('E2E-PA06-03: end one session with a reason', async ({ browser }) => {
    const target = world().brightops.owner;
    // A live session of the target to end.
    const theirs = await openAs(browser, target.id);
    const { context, page } = await openAdmin(browser, `/platform/people/${target.id}/security`);
    const sessions = page.getByRole('table', { name: 'Sessions' });
    await sessions.getByRole('button', { name: 'End' }).first().click();
    await confirmReason(page, 'Lost laptop, ticket 4821', 'End session');
    await expect(sessions.getByText('Ended').first()).toBeVisible();
    await theirs.context.close();
    await context.close();
  });

  test('E2E-PA06-04: reset two-step needs a reason; require-at-sign-in is then on, and off again', async ({
    browser,
  }) => {
    const target = world().brightops.owner;
    const { context, page, csrf } = await openAdmin(
      browser,
      `/platform/people/${target.id}/security`,
    );
    const base = `${API_URL}/v1/platform/people/${target.id}/two-step/reset`;
    const headers = { 'x-csrf-token': csrf, origin: WEB_URL };
    // The account has no factor, so the drawn Reset button is disabled ("Not set up"); the route
    // itself is exercised: no reason is a 400, a reason resets and requires enrolment.
    await expect(page.getByRole('button', { name: 'Reset two-step' })).toBeDisabled();
    const refused = await context.request.post(base, { headers, data: {} });
    expect(refused.status()).toBe(400);
    const reset = await context.request.post(base, {
      headers,
      data: { reason: 'Phone lost, ticket 4822', signOut: false },
    });
    expect(reset.ok()).toBe(true);

    await page.reload();
    const require = page.getByLabel('Require two-step at next sign-in');
    await expect(require).toBeChecked();
    await require.uncheck();
    await expect(require).not.toBeChecked();
    await context.close();
  });

  test('E2E-PA06-05: disable with a reason refuses the right password neutrally; enable restores', async ({
    browser,
  }) => {
    const target = world().supportCandidate;
    const wrong = await passwordSignIn(browser, target.email, 'not the password at all');
    expect(wrong.status).toBe(401);

    const { context, page } = await openAdmin(browser, `/platform/people/${target.id}`);
    await page.getByRole('button', { name: 'Disable account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('DESTRUCTIVE · REASON REQUIRED')).toBeVisible();
    await dialog.getByRole('button', { name: 'Disable account' }).click();
    await expect(
      dialog.getByText('Add a reason — it is saved in the platform audit log'),
    ).toBeVisible();
    await confirmReason(page, 'Left the company, ticket 4823', 'Disable account');
    await expect(page.getByText(/Sign-in is blocked and every session has ended/u)).toBeVisible();

    const refused = await passwordSignIn(browser, target.email, target.password);
    expect(refused.status).toBe(401);
    expect(refused.message).toBe(wrong.message);

    await page.getByRole('button', { name: 'Enable account' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enable account' }).click();
    await expect(page.getByRole('button', { name: 'Disable account' })).toBeVisible();
    const admitted = await passwordSignIn(browser, target.email, target.password);
    expect(admitted.status).toBeLessThan(300);
    await context.close();
  });

  test('E2E-PA06-06: the Arabic people list is right-to-left', async ({ browser }) => {
    const { context, page } = await openAdmin(browser, '/platform/people');
    await page.goto('/platform/people?lang=ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'الأشخاص' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'عرض الجميع' })).toBeVisible();
    await context.close();
  });
});
