import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * Onboarding and the organization boundary, through a real browser.
 *
 * - **E2E-09, "First organization/project/client onboarding: role previews and
 *   invitations correct"** — a person creates an organization, files its first project,
 *   invites a teammate, and the teammate follows the link in a second browser context and
 *   lands inside. The invitation link is scraped from ON-04's "Links to send" panel the
 *   way a human would copy it — and under this stack's `EMAIL_DRIVER=console` the screen
 *   must say **nothing emailed it**, which is the mailer slice's `delivery: 'none'`
 *   answer read end to end. Two catalog steps are narrower than the sentence and said
 *   so in `docs/implementation-status.md`: ON-02's template choice is not stored (its
 *   button is disabled), so the journey navigates past it; and the client-organization
 *   half of onboarding (ON-05/ON-06) has no screen yet.
 * - **AUTH-01, "Org ID swapped in path: 404/deny without metadata"** — a Northstar member
 *   swaps another organization's slug into the path and gets the one refusal that does
 *   not distinguish "not yours" from "not real", for both a stranger organization and
 *   the adversarial near-twin.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly designer: SeededUser;
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

const ORG_NAME = 'Lighthouse Films';
const ORG_SLUG = 'lighthouse-films';

test.describe.serial('the onboarding journeys', () => {
  test('E2E-09: an organization is founded, a project filed, a teammate invited and admitted', async ({
    browser,
  }) => {
    const founder = await openAs(browser, world().northstar.owner.id);

    // ON-01: found the organization. Success lands on ON-02, whose slug is in the URL —
    // the proof the founder's owner membership resolved on the very next request.
    await founder.page.goto('/onboarding/organization');
    await founder.page.getByLabel('Organization name').fill(ORG_NAME);
    await expect(founder.page.getByLabel('Workspace address')).toHaveValue(ORG_SLUG);
    await founder.page.getByRole('button', { name: 'Create organization' }).click();
    await founder.page.waitForURL(`**/${ORG_SLUG}/onboarding/template`);

    // ON-02 stores nothing and its forward button is disabled — navigate past it.
    await founder.page.goto(`/${ORG_SLUG}/onboarding/project`);
    await founder.page.getByLabel('Project name').fill('Autumn Brand Film');
    await founder.page.getByLabel('Target date').fill('2026-10-15');
    await founder.page.getByRole('button', { name: 'Create project' }).click();
    await founder.page.waitForURL(`**/${ORG_SLUG}/onboarding/team`);

    // ON-04: invite a teammate, read the role preview, create the invitation.
    await founder.page.getByLabel('Email address').fill('lina@northstar.studio');
    await expect(founder.page.getByText('What a team member will see')).toBeVisible();
    await founder.page.getByRole('button', { name: 'Add to the list' }).click();
    await founder.page.getByRole('button', { name: 'Create 1 invitation' }).click();

    // The row for that address, asserted whole. `StateCapsule` puts an `aria-hidden` glyph in
    // front of its word and Playwright counts it as text, so the capsule reads "✓Created" and
    // an exact-text assertion on "Created" matches nothing — this suite's first run is what
    // established that. The negative is asserted too, because a substring match on "Created"
    // is case-insensitive and would also be satisfied by "Not created".
    await expect(founder.page.getByText('Links to send')).toBeVisible();
    const invited = founder.page
      .getByRole('region', { name: 'Links to send' })
      .getByRole('listitem')
      .filter({ hasText: 'lina@northstar.studio' });
    await expect(invited).toContainText('Created');
    await expect(invited).not.toContainText('Not created');
    // EMAIL_DRIVER=console: the server's delivery answer is 'none' and the screen says so.
    await expect(
      founder.page.getByText('Nothing emailed this link — you have to send it yourself.'),
    ).toBeVisible();

    // The link is shown exactly once; copy it the way a person would.
    const linkText = await founder.page.locator('p.tm-mono.tm-break').innerText();
    const match = /\/invitations\/([A-Za-z0-9_-]{40,64})/u.exec(linkText);
    expect(match).not.toBeNull();
    const token = (match as RegExpExecArray)[1] as string;

    // The teammate follows it in a second context — signed in as themselves first,
    // because accepting binds the session's account.
    const teammate = await openAs(browser, world().northstar.designer.id);
    await teammate.page.goto(`/invitations/${token}`);
    await expect(teammate.page.getByText(`Join ${ORG_NAME}.`)).toBeVisible();
    await expect(teammate.page.getByRole('heading', { name: /invited you/u })).toBeVisible();
    await teammate.page.getByRole('button', { name: 'Accept invitation' }).click();
    await teammate.page.waitForURL('**/organizations');

    // The selector now lists the new organization as an internal membership.
    const row = teammate.page.getByRole('link', { name: new RegExp(ORG_NAME, 'u') });
    await expect(row).toBeVisible();
    await expect(row.getByText('Internal member')).toBeVisible();

    await founder.context.close();
    await teammate.context.close();
  });

  test('AUTH-01: a swapped organization slug earns the refusal that names nothing', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.designer.id);

    // A stranger organization's slug.
    await member.page.goto('/brightops-consulting/work');
    await expect(member.page.getByText('Could not load the work list')).toBeVisible();
    await expect(
      member.page.getByText('No organization matching that identifier is available to you'),
    ).toBeVisible();
    await expect(member.page.getByText('BrightOps Consulting')).toHaveCount(0);
    await expect(member.page.getByText('Map approval chain for vendor payments')).toHaveCount(0);

    // The adversarial near-twin — one letter away — gets the byte-identical refusal.
    await member.page.goto('/northstar-studios/work');
    await expect(member.page.getByText('Could not load the work list')).toBeVisible();
    await expect(
      member.page.getByText('No organization matching that identifier is available to you'),
    ).toBeVisible();

    await member.context.close();
  });
});
