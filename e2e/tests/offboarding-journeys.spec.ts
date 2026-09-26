import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * Member offboarding in a real browser against the real stack — ADM-12 / ADM-13 (x121).
 *
 * The access-revocation boundary end to end: an owner previews the access a member holds, then
 * offboards them, and the member drops out of the active directory. And the security substance the
 * unit tests prove over fakes, proven here through the real capability guard and the real
 * transaction — a caller cannot offboard themselves, and cannot offboard the last administrator.
 *
 * Northstar's seed world: Maya (owner), Omar (manager), Lina (member/designer). Lina is the safe
 * subject — offboarding her removes no administrator — and Maya is both the caller and the last
 * `org.manage` holder, so an attempt on herself must be refused twice over.
 */

interface SeededUser {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const SLUG = 'northstar-studio';

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
}

test.describe('the member offboarding journeys', () => {
  test('an owner previews a member’s access, then offboards them, and they leave the directory', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();

    const designer = world().northstar.designer;

    await page.goto(`/${SLUG}/people/offboarding`);

    // Pick the member by name — the directory offers names, the API is driven by the user id.
    const picker = page.getByRole('combobox', { name: 'Member to offboard' });
    await picker.fill(designer.displayName.slice(0, 4));
    await page.getByRole('option', { name: new RegExp(designer.displayName) }).click();

    // The impact preview loads the access this member holds.
    const impact = page.getByRole('region', { name: new RegExp('Offboarding impact') });
    await expect(impact.getByText(/project memberships/)).toBeVisible();
    await expect(impact.getByText(/work items/)).toBeVisible();

    // Offboarding is behind an explicit acknowledgement that it cannot be undone.
    await page.getByRole('checkbox', { name: /cannot be undone/i }).check();
    await page.getByRole('button', { name: new RegExp(`Offboard ${designer.displayName}`) }).click();

    await expect(page.getByText('Member offboarded')).toBeVisible();

    // The member is gone from the active directory: the picker no longer offers them.
    await picker.fill(designer.displayName.slice(0, 4));
    await expect(page.getByRole('option', { name: new RegExp(designer.displayName) })).toHaveCount(0);
  });

  test('the owner cannot offboard themselves — the last administrator is protected', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await signIn(context, world().northstar.owner.id);
    const page = await context.newPage();

    const owner = world().northstar.owner;

    await page.goto(`/${SLUG}/people/offboarding`);

    const picker = page.getByRole('combobox', { name: 'Member to offboard' });
    await picker.fill(owner.displayName.slice(0, 4));
    await page.getByRole('option', { name: new RegExp(owner.displayName) }).click();

    await page.getByRole('checkbox', { name: /cannot be undone/i }).check();
    await page.getByRole('button', { name: new RegExp(`Offboard ${owner.displayName}`) }).click();

    // The API refuses (self, and last administrator), and the screen renders the refusal rather
    // than a blank page or a success. The member is still there.
    await expect(page.getByText('Offboarding failed')).toBeVisible();
  });
});
