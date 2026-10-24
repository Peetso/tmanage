import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, drainOutbox } from '../setup/stack.js';

/**
 * **J4 — Client approval**, end to end through a real browser against the real stack.
 *
 * Every step is the screen a person uses, with nothing seeded for it beyond the two-tenant world:
 *
 * 1. **Q1 Clients screen** (df8c4bfe) — the studio owner opens Clients, invites a person from a
 *    client company typed in as a new name, and copies the one-time link (under this stack's
 *    `EMAIL_DRIVER=console` nothing is emailed, so the screen shows it).
 * 2. **Q2 New project client picker** (a03cea30) — the owner creates a project and picks that
 *    company as its client; `PUT projects/:id/client` shares it.
 * 3. **ID-03 registration** — the invited person has no account: they follow the link, create one,
 *    and land signed in. The Clients screen then counts them.
 * 4. **BG2 / P7 Deliverables** (5a78ae88 / 834edf7e) — the owner creates a deliverable, adds a
 *    version, and sends it for approval to that person (the Approver picker lists them).
 * 5. **The client decides in the portal** — changes requested on v1 (with a note the team then
 *    reads), and, after a v2, an approval.
 * 6. **Q3 the team is told** (15274f2d) — after the worker drains the outbox, the sender's
 *    notification feed holds one `approval.decided.v1` about each decided version.
 * 7. **BG3 / P8 request conversation** (311efb33) — the client asks for something on the project,
 *    the team replies in the request's conversation, and the client replies back.
 *
 * The "manager" of the journey is the studio **owner**: the Clients screen and "Add a new client"
 * are behind `org.manage`, which the seeded `manager` role does not hold.
 *
 * Serial on purpose: every step reads what the previous one created.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: { readonly owner: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

function databaseUrl(): string {
  return process.env['TMANAGE_E2E_DATABASE_URL'] as string;
}

function storageRoot(): string {
  return process.env['TMANAGE_E2E_STORAGE_ROOT'] as string;
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

const SLUG = 'northstar-studio';
// Unique per run, so a retry inside one stack never collides with what a first attempt created.
const RUN = Date.now().toString(36);
const COMPANY = `Harbor Lights Hotels ${RUN}`;
const CLIENT_EMAIL = `nadia.${RUN}@harborlights.example`;
const CLIENT_NAME = 'Nadia Fahmy';
// A test value for this stack only: long, and free of the email local part and the name.
const CLIENT_PASSWORD = 'lantern-orbit-velvet-4271';
const PROJECT = `Harbor Lights Booking Site ${RUN}`;
const DELIVERABLE = 'Homepage hero';
const V1_NOTE = 'First cut of the hero with the sea view photograph.';
const V2_NOTE = 'Second cut: the headline is softer and the booking button moved up.';
const CHECK_NOTE = 'Does the hero feel like Harbor Lights?';
const FEEDBACK = 'Please soften the headline and move the booking button higher.';
const REQUEST_TITLE = 'Add the winter rates page';
const TEAM_REPLY = 'Happy to. Should the winter rates include the spa packages?';
const CLIENT_REPLY = 'Yes, include the spa packages, but not the restaurant offers.';

interface FeedItem {
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
}

/** The acting person's own notification feed (x151), newest first. */
async function feed(context: BrowserContext): Promise<readonly FeedItem[]> {
  const response = await context.request.get(
    `${API_URL}/v1/organizations/${SLUG}/notifications?limit=100`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: readonly FeedItem[] }).items;
}

test.describe.serial('J4 — the client approval journeys', () => {
  let projectId: string;
  let deliverablesUrl: string;
  let firstVersionId: string;
  let clientContext: BrowserContext;
  let clientPage: Page;

  test.afterAll(async () => {
    await clientContext?.close();
  });

  test('J4a: the owner invites a client and files a project for them, and the client joins', async ({
    browser,
  }) => {
    const owner = await openAs(browser, world().northstar.owner.id);

    // Q1: the Clients screen, "Invite client", a company typed in as a new name.
    await owner.page.goto(`/${SLUG}/clients`);
    // The seeded companies are listed once the screen has hydrated and its query answered.
    await expect(
      owner.page.getByRole('list', { name: 'Client organizations' }).getByText('Atlas Hospitality'),
    ).toBeVisible();
    await owner.page.getByRole('button', { name: 'Invite client' }).click();
    const dialog = owner.page.getByRole('dialog', { name: 'Invite a client' });
    await dialog.getByLabel('Email').fill(CLIENT_EMAIL);
    await dialog.getByLabel('Client organization').fill(COMPANY);
    await expect(dialog.getByRole('checkbox', { name: /^Reviewer/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog).toHaveCount(0);

    // Nothing was emailed under the console driver, so the one-time link is on screen.
    await expect(owner.page.getByText('Send this link yourself')).toBeVisible();
    const link = await owner.page.getByLabel('Invitation link').inputValue();
    const match = /\/invitations\/([^/?#]+)$/u.exec(link);
    expect(match, `an invitation link, got ${link}`).not.toBeNull();
    const token = decodeURIComponent((match as RegExpExecArray)[1] as string);

    // The company and its pending invitation are listed.
    await expect(
      owner.page.getByRole('list', { name: 'Client organizations' }).getByText(COMPANY),
    ).toBeVisible();
    await expect(
      owner.page.getByRole('list', { name: 'Pending invitations' }).getByText(CLIENT_EMAIL),
    ).toBeVisible();

    // Q2: a new project with that company picked as its client.
    await owner.page.goto(`/${SLUG}/projects/new`);
    const projectName = owner.page.getByLabel('Project name');
    // The form ships disabled until React has hydrated and the workspaces answered.
    await expect(projectName).toBeEnabled();
    await projectName.fill(PROJECT);
    const picker = owner.page.getByRole('combobox', { name: 'Client', exact: true });
    await picker.fill(COMPANY.slice(0, 12));
    await owner.page.getByRole('option', { name: COMPANY }).click();
    await expect(
      owner.page.getByText('Share with the client after the first update'),
    ).toBeVisible();
    await owner.page.getByRole('button', { name: 'Create project' }).click();
    await owner.page.waitForURL(/\/projects\/[0-9a-f-]{36}$/u);
    projectId = /\/projects\/([0-9a-f-]{36})$/u.exec(owner.page.url())?.[1] as string;
    deliverablesUrl = `/${SLUG}/projects/${projectId}/deliverables`;

    // The share is real: the project's client list names the company.
    const shares = await owner.context.request.get(
      `${API_URL}/v1/organizations/${SLUG}/projects/${projectId}/clients`,
    );
    expect(shares.ok()).toBe(true);
    expect(
      ((await shares.json()) as { clients: readonly { clientOrganizationId: string }[] }).clients,
    ).toHaveLength(1);

    // The invited person has no account: the link offers the registration form.
    clientContext = await browser.newContext();
    clientPage = await clientContext.newPage();
    await clientPage.goto(`/invitations/${encodeURIComponent(token)}`);
    await expect(
      clientPage.getByRole('heading', { level: 1, name: 'Create your account' }),
    ).toBeVisible();
    await expect(clientPage.getByLabel('Work email')).toHaveValue(CLIENT_EMAIL);
    await clientPage.getByLabel('Full name').fill(CLIENT_NAME);
    await clientPage.getByRole('textbox', { name: 'Password', exact: true }).fill(CLIENT_PASSWORD);
    await clientPage.getByLabel('Confirm password').fill(CLIENT_PASSWORD);
    await clientPage.getByRole('checkbox', { name: /I agree to the Terms/ }).check();
    await clientPage.getByRole('button', { name: 'Create account and join' }).click();
    await clientPage.waitForURL('**/organizations');

    // The Clients screen now counts one person in the company and no pending invitation.
    await owner.page.goto(`/${SLUG}/clients`);
    const companyRow = owner.page
      .getByRole('list', { name: 'Client organizations' })
      .getByRole('listitem')
      .filter({ hasText: COMPANY });
    await expect(companyRow).toContainText('1 person');
    await expect(owner.page.getByText(CLIENT_EMAIL)).toHaveCount(0);

    await owner.context.close();
  });

  test('J4b: a version goes out, the client requests changes, and the team is told', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const owner = await openAs(browser, world().northstar.owner.id);

    // P7: create the deliverable and open it.
    await owner.page.goto(deliverablesUrl);
    const create = owner.page.getByRole('region', { name: 'New deliverable' });
    // The list's empty state is the query's answer, so the form is hydrated past this line.
    await expect(owner.page.getByText('No deliverables yet.', { exact: false })).toBeVisible();
    await create.getByLabel('Title').fill(DELIVERABLE);
    await create.getByRole('button', { name: 'Create deliverable' }).click();
    await owner.page.getByRole('link', { name: DELIVERABLE }).click();
    await owner.page.waitForURL(/\/deliverables\/[0-9a-f-]{36}$/u);

    // v1, a note-only version (the file path is the upload pipeline's own journey).
    await owner.page.getByLabel('Note', { exact: true }).fill(V1_NOTE);
    await owner.page.getByRole('button', { name: 'Upload new version' }).click();
    const versions = owner.page.getByRole('region', { name: 'Versions' });
    const v1 = versions.getByRole('listitem').filter({ hasText: V1_NOTE });
    await expect(v1).toContainText('Not sent');

    // BG2: Send for approval — the approver picker lists the person who just joined.
    await v1.getByRole('button', { name: 'Send for approval' }).click();
    const send = owner.page.getByRole('dialog', { name: 'Send for approval' });
    await expect(send.getByRole('combobox', { name: 'Approver' })).toContainText(
      `${CLIENT_NAME} · ${COMPANY}`,
    );
    await send.getByLabel('What should they check?').fill(CHECK_NOTE);
    await send.getByRole('button', { name: 'Send for approval' }).click();
    await expect(send).toHaveCount(0);
    await expect(v1).toContainText('Waiting for the client');
    await expect(v1.getByRole('link', { name: 'Open in the client portal' })).toBeVisible();

    // The client finds it in the portal's deliverables and requests changes with a note.
    await clientPage.goto(`/${SLUG}/portal/deliverables`);
    await clientPage.getByRole('link', { name: `${DELIVERABLE} · v1` }).click();
    await clientPage.waitForURL(/\/portal\/deliverables\/[0-9a-f-]{36}$/u);
    firstVersionId = /\/portal\/deliverables\/([0-9a-f-]{36})$/u.exec(
      clientPage.url(),
    )?.[1] as string;
    await expect(clientPage.getByText(CHECK_NOTE).first()).toBeVisible();
    await clientPage.getByLabel(/A note for/).fill(FEEDBACK);
    await clientPage.getByRole('button', { name: 'Request changes' }).click();
    await expect(clientPage.getByText('You requested changes')).toBeVisible();

    // The team's detail shows the decision and the client's words against v1.
    await owner.page.reload();
    await expect(v1).toContainText('Changes requested');
    await expect(v1).toContainText(FEEDBACK);

    // Q3: once the worker runs, the sender is told about this version's decision.
    await drainOutbox(databaseUrl(), storageRoot());
    const told = (await feed(owner.context)).filter(
      (item) => item.type === 'approval.decided.v1' && item.objectId === firstVersionId,
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.objectType).toBe('deliverable_version');

    await owner.context.close();
  });

  test('J4c: the next version goes out and the client approves it', async ({ browser }) => {
    test.setTimeout(240_000);
    const owner = await openAs(browser, world().northstar.owner.id);

    await owner.page.goto(deliverablesUrl);
    await owner.page.getByRole('link', { name: DELIVERABLE }).click();
    await owner.page.waitForURL(/\/deliverables\/[0-9a-f-]{36}$/u);

    await owner.page.getByLabel('Note', { exact: true }).fill(V2_NOTE);
    await owner.page.getByRole('button', { name: 'Upload new version' }).click();
    const versions = owner.page.getByRole('region', { name: 'Versions' });
    const v2 = versions.getByRole('listitem').filter({ hasText: V2_NOTE });
    await expect(v2).toContainText('Not sent');

    await v2.getByRole('button', { name: 'Send for approval' }).click();
    const send = owner.page.getByRole('dialog', { name: 'Send for approval' });
    await expect(send.getByRole('combobox', { name: 'Approver' })).toContainText(CLIENT_NAME);
    await send.getByRole('button', { name: 'Send for approval' }).click();
    await expect(send).toHaveCount(0);
    await expect(v2).toContainText('Waiting for the client');

    await clientPage.goto(`/${SLUG}/portal/deliverables`);
    await clientPage.getByRole('link', { name: `${DELIVERABLE} · v2` }).click();
    await clientPage.waitForURL(/\/portal\/deliverables\/[0-9a-f-]{36}$/u);
    const secondVersionId = /\/portal\/deliverables\/([0-9a-f-]{36})$/u.exec(
      clientPage.url(),
    )?.[1] as string;
    expect(secondVersionId).not.toBe(firstVersionId);
    await clientPage.getByRole('button', { name: 'Approve this version' }).click();
    await expect(clientPage.getByText('You approved this version')).toBeVisible();

    await owner.page.reload();
    await expect(v2).toContainText('Approved');
    await expect(v2.getByRole('button', { name: 'Send for approval' })).toHaveCount(0);

    await drainOutbox(databaseUrl(), storageRoot());
    const told = (await feed(owner.context)).filter(
      (item) => item.type === 'approval.decided.v1' && item.objectId === secondVersionId,
    );
    expect(told).toHaveLength(1);

    await owner.context.close();
  });

  test('J4d: the client asks for something and the two sides talk it over on the request', async ({
    browser,
  }) => {
    // The client asks, on the one project shared with them.
    await clientPage.goto(`/${SLUG}/portal/requests/new`);
    await expect(clientPage.getByLabel('The request')).toBeEnabled();
    await clientPage.getByLabel('The request').fill(REQUEST_TITLE);
    await clientPage.getByLabel('Why it matters').fill('Winter bookings open next month.');
    await clientPage.getByLabel('When you would like it').fill('2026-12-01');
    await clientPage.getByRole('button', { name: 'Send request' }).click();
    await expect(
      clientPage.getByRole('heading', { name: 'Your request is with the studio' }),
    ).toBeVisible();
    const requestUrl = await clientPage
      .getByRole('link', { name: 'See this request' })
      .getAttribute('href');
    expect(requestUrl).toBeTruthy();

    // The team opens it and replies, client-visible. A7 (fq9-triage) made the triage screen's
    // "Reply to <first name>" box the composer: a fresh request shows no conversation yet, and
    // the reply then appears in the request's conversation above the box.
    const owner = await openAs(browser, world().northstar.owner.id);
    await owner.page.goto(`/${SLUG}/work/requests`);
    await owner.page.getByRole('link', { name: REQUEST_TITLE }).click();
    await expect(owner.page.getByRole('heading', { name: REQUEST_TITLE })).toBeVisible();
    await expect(
      owner.page.getByRole('region', { name: 'Conversation with the client' }),
    ).toHaveCount(0);
    await owner.page.getByRole('textbox', { name: /^Reply to / }).fill(TEAM_REPLY);
    await owner.page.getByRole('button', { name: 'Send reply' }).click();
    await expect(owner.page.getByText('Reply sent.')).toBeVisible();
    const teamThread = owner.page.getByRole('region', { name: 'Conversation with the client' });
    await expect(
      teamThread.getByRole('list', { name: 'Messages on this request' }).getByText(TEAM_REPLY),
    ).toBeVisible();

    // The client reads the reply on their side and answers (A8's reply card: "Your reply").
    await clientPage.goto(requestUrl as string);
    const clientThread = clientPage.getByRole('region', { name: 'Conversation with the studio' });
    const clientMessages = clientThread.getByRole('list', { name: 'Messages on this request' });
    await expect(clientMessages.getByText(TEAM_REPLY)).toBeVisible();
    await clientThread.getByLabel('Your reply').fill(CLIENT_REPLY);
    await clientThread.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(clientMessages.getByText(CLIENT_REPLY)).toBeVisible();

    // The team sees the client's answer under their own reply.
    await owner.page.reload();
    const teamMessages = owner.page
      .getByRole('region', { name: 'Conversation with the client' })
      .getByRole('list', { name: 'Messages on this request' });
    await expect(teamMessages.getByText(TEAM_REPLY)).toBeVisible();
    await expect(teamMessages.getByText(CLIENT_REPLY)).toBeVisible();

    await owner.context.close();
  });
});
