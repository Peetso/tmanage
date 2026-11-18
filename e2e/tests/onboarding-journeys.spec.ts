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
 * - **ON-10, "Guided tour progress"** — a seeded member of the studio opens their own guided
 *   tour (module 3), marks two steps done, reloads the whole page and finds the same two still
 *   done with no control to redo them — the proof the progress is the server's memory of what the
 *   member finished, not the tab's. A second member of the SAME studio opens their own tour and
 *   sees it untouched, because the API takes no membership id and answers only the acting member's
 *   own (own-principal, read end to end). The checklist is ON-10's progress surface; its
 *   sample-data seeding and dismissable coach-marks are deferred (NS-13) and are not asserted.
 */

interface SeededUser {
  readonly id: string;
  readonly email: string;
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

    // ON-01: found the organization. Success lands on the 55-01 wizard, whose slug is in the URL —
    // the proof the founder's owner membership resolved on the very next request.
    await founder.page.goto('/onboarding/organization');
    await founder.page.getByLabel('Organization name').fill(ORG_NAME);
    await expect(founder.page.getByLabel('Workspace web link')).toHaveValue(ORG_SLUG);
    await founder.page.getByRole('button', { name: 'Create organization' }).click();
    await founder.page.waitForURL(`**/${ORG_SLUG}/onboarding`);

    // The wizard and ON-02 store nothing this journey needs — navigate past them.
    await founder.page.goto(`/${ORG_SLUG}/onboarding/project`);
    await founder.page.getByLabel('Project name').fill('Autumn Brand Film');
    await founder.page.getByLabel('Target date').fill('2026-10-15');
    await founder.page.getByRole('button', { name: 'Create project' }).click();
    // ON-03 hands over `?project=created`, which the team step reads as "project made".
    await founder.page.waitForURL(
      new RegExp(`/${ORG_SLUG}/onboarding/team\\?project=created$`, 'u'),
    );

    // ON-04: invite a teammate, read the role preview, create the invitation.
    // The teammate's own seeded address: the invitation screen branches on whether the invited
    // address already has an account (P1 Getting in, 36d80fac). An address with no account gets
    // the sign-up form; this journey is the existing-account path that signs in and accepts.
    const teammateEmail = world().northstar.designer.email;
    await founder.page.getByLabel('Email address').fill(teammateEmail);
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
      .filter({ hasText: teammateEmail });
    await expect(invited).toContainText('Created');
    await expect(invited).not.toContainText('Not created');
    // EMAIL_DRIVER=console: the server's delivery answer is 'none' and the screen says so.
    await expect(
      founder.page.getByText('Nothing emailed this link — you have to send it yourself.'),
    ).toBeVisible();

    // The link is shown exactly once; copy it the way a person would.
    const linkText = await founder.page.getByTestId('tm-invitation-link').innerText();
    const match = /\/invitations\/([A-Za-z0-9_-]{40,64})/u.exec(linkText);
    expect(match).not.toBeNull();
    const token = (match as RegExpExecArray)[1] as string;

    // The teammate follows it in a second context — signed in as themselves first,
    // because accepting binds the session's account.
    const teammate = await openAs(browser, world().northstar.designer.id);
    await teammate.page.goto(`/invitations/${token}`);
    // The redesigned acceptance screen (ID-03, Figma t1-a) heads with the organization for an
    // address that has an account, and names the inviter and the organization in a line above it.
    await expect(
      teammate.page.getByRole('heading', { level: 1, name: `Join ${ORG_NAME}` }),
    ).toBeVisible();
    await expect(teammate.page.getByText(`invited you to ${ORG_NAME}`)).toBeVisible();
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

    // A stranger organization's slug. The shell's membership gate (CQ-03) decides from the
    // session's own organization list, so any slug not on it gets the same not-found page.
    await member.page.goto('/brightops-consulting/work');
    await expect(
      member.page.getByRole('heading', { name: 'We couldn’t find that page' }),
    ).toBeVisible();
    const strangerMain = await member.page.getByRole('main').innerText();
    await expect(member.page.getByText('BrightOps Consulting')).toHaveCount(0);
    await expect(member.page.getByText('Map approval chain for vendor payments')).toHaveCount(0);

    // The adversarial near-twin — one letter away, and no such organization — gets the
    // identical refusal, so the page tells nothing about which slugs exist.
    await member.page.goto('/northstar-studios/work');
    await expect(
      member.page.getByRole('heading', { name: 'We couldn’t find that page' }),
    ).toBeVisible();
    expect(await member.page.getByRole('main').innerText()).toBe(strangerMain);

    await member.context.close();
  });
});

/** The seeded studio the guided-tour members belong to. */
const TOUR_SLUG = 'northstar-studio';

test.describe('the guided tour journey', () => {
  test('ON-10: a member walks the guided tour, progress survives a reload, and a second member is untouched', async ({
    browser,
  }) => {
    // A member of the seeded studio opens their own guided tour — fresh, nothing finished yet.
    const designer = await openAs(browser, world().northstar.designer.id);
    await designer.page.goto(`/${TOUR_SLUG}/onboarding/tour`);

    const panel = designer.page.getByRole('region', { name: 'Your progress' });
    await expect(designer.page.getByText('0 of 5 steps done.')).toBeVisible();

    // Each row carries exactly one "Mark done" control while the step is outstanding.
    const welcomeRow = panel.getByRole('listitem').filter({ hasText: 'Take a look around' });
    const projectRow = panel.getByRole('listitem').filter({ hasText: 'Create your first project' });
    await expect(welcomeRow.getByRole('button')).toBeVisible();

    // Advance the first step. The count line and that row both flip (the redesigned row says
    // "Done"), and the write is the server's — the mutation returns the new progress the
    // checklist re-renders from.
    await welcomeRow.getByRole('button').click();
    await expect(designer.page.getByText('1 of 5 steps done.')).toBeVisible();
    await expect(welcomeRow.getByText('Done', { exact: true })).toBeVisible();
    await expect(welcomeRow.getByRole('button')).toHaveCount(0);

    // Advance a second step.
    await projectRow.getByRole('button').click();
    await expect(designer.page.getByText('2 of 5 steps done.')).toBeVisible();

    // The proof the state is the server's, not the tab's: a full reload shows the same two steps
    // done and offers no control to redo them — a fresh browser would read the same.
    await designer.page.reload();
    await expect(designer.page.getByText('2 of 5 steps done.')).toBeVisible();
    await expect(welcomeRow.getByText('Done', { exact: true })).toBeVisible();
    await expect(projectRow.getByText('Done', { exact: true })).toBeVisible();
    await expect(welcomeRow.getByRole('button')).toHaveCount(0);

    // A second member of the SAME studio opens their own tour — untouched by the first member's
    // progress, because the API takes no membership id and answers only the acting member's own.
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto(`/${TOUR_SLUG}/onboarding/tour`);
    const managerPanel = manager.page.getByRole('region', { name: 'Your progress' });
    await expect(manager.page.getByText('0 of 5 steps done.')).toBeVisible();
    await expect(
      managerPanel
        .getByRole('listitem')
        .filter({ hasText: 'Take a look around' })
        .getByRole('button'),
    ).toBeVisible();

    await designer.context.close();
    await manager.context.close();
  });
});
