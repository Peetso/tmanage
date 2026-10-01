import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * E2E-05 — the client deep link: **client opens the governed/published version → sees the
 * projection → decides** (approve, case A; request changes with a note, case B), and the
 * `approvals` row transitions and persists exactly as the reviewer decide does (FR-05, x101).
 *
 * ## How the fixture is wired (T001)
 *
 * The journey reads its fixture from the seeded world, but **nothing in the running stack can
 * create one at runtime**:
 *   - There is no HTTP route that creates a `deliverable_versions` row. `POST …/approvals`
 *     (open) and `POST …/approvals/projections` (publish) both require a version id that already
 *     exists, and no controller mints one — a deliverable version is an internal content-identity
 *     row with no create endpoint (see `deliverable-versions.repository.ts`, which is written to
 *     from tests only).
 *   - `seed-two-tenants.ts` seeds no `deliverable_versions` / `approvals` / `client_projections`
 *     rows (the x92/x97 DB suites build them per-test through the repositories).
 *
 * So the harness spawns a fixture before the journey — the shape of `ageUploadSession` in
 * `e2e/setup/stack.ts`: `apps/api/test/approval-fixture-cli.ts`, given the Northstar tenant and the
 * Atlas client's shared project, inserts a governed `deliverable_versions` row through the real
 * scoped repositories, opens an `approvals` row over it, and publishes a `client_projections` row
 * whose `approvedContacts` names the Atlas contact — twice, so the two serial cases decide on
 * different versions. `stack.ts` exposes the two version ids on the world as
 * `atlas.approval.{deliverableVersionId, secondDeliverableVersionId}`, which the cases read below.
 *
 * The API decision itself is already proven: `approvals.service.test.ts` covers the client decide
 * end to end with the real `authorize()` and state machine (approve, request-changes-with-note,
 * off-relation refusal, unknown/cross-tenant id → 404, append-only re-decide → 409).
 *
 * Serial on purpose: case B visits the same deep link case A approved is deliberately a *second*
 * version, so the two cases do not fight over one append-only approval.
 */

interface SeededUser {
  readonly id: string;
}

interface ApprovalFixture {
  /** The governed, published version the deep link is addressed by. */
  readonly deliverableVersionId: string;
  /** A second published version, so case B decides without colliding with case A. */
  readonly secondDeliverableVersionId: string;
}

interface World {
  readonly northstar: { readonly manager: SeededUser };
  readonly atlas: {
    readonly admin: SeededUser;
    readonly reviewer: SeededUser;
    /** Present once the approval fixture (see the header) is seeded. */
    readonly approval?: ApprovalFixture;
  };
  readonly meridian: { readonly reviewer: SeededUser };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/**
 * The dev sign-in route the API registers outside production — a session, not a mock.
 *
 * Returns the CSRF token the route issues. A cookie-authenticated mutation made directly through
 * `context.request` (not the browser app) must echo this token in `X-CSRF-Token`, exactly as the
 * web client does from the readable cookie — without it `CsrfGuard` refuses the write with 403
 * before it reaches the service (04 §3, SEC-03).
 */
async function signIn(context: BrowserContext, userId: string): Promise<string> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return csrfToken;
}

test.describe('E2E-05 — the client deep-link decide journeys', () => {
  async function openAs(
    browser: Browser,
    userId: string,
  ): Promise<{ context: BrowserContext; page: Page; csrfToken: string }> {
    const context = await browser.newContext();
    const csrfToken = await signIn(context, userId);
    const page = await context.newPage();
    return { context, page, csrfToken };
  }

  function deepLink(deliverableVersionId: string): string {
    return `/northstar-studio/portal/deliverables/${deliverableVersionId}`;
  }

  test('E2E-05a: a client opens the published version, sees the projection, and approves', async ({
    browser,
  }) => {
    const fixture = world().atlas.approval;
    expect(fixture, 'the approval fixture must be seeded — see the file header').toBeTruthy();
    const versionId = (fixture as ApprovalFixture).deliverableVersionId;

    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto(deepLink(versionId));

    // The projection is visible — the allowlisted client-safe view, not the internal record.
    await expect(client.page.getByRole('heading', { name: /.+/ })).toBeVisible();
    await expect(client.page.getByRole('button', { name: 'Approve' })).toBeEnabled();

    // The client approves, and the confirmation replaces the actions.
    await client.page.getByRole('button', { name: 'Approve' }).click();
    await expect(client.page.getByText('You approved this version')).toBeVisible();
    await expect(client.page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    // The persisted outcome: the client decide route now reads the approval as decided. A second
    // decide on the same version is refused as append-only (409), which the screen never re-offers.
    // The direct call must carry the CSRF token the browser app echoes from its readable cookie,
    // or `CsrfGuard` refuses the mutation with 403 before the append-only check is ever reached.
    const reread = await client.context.request.post(
      `${API_URL}/v1/organizations/northstar-studio/approvals/projections/${versionId}/decision`,
      { data: { decision: 'approve' }, headers: { 'X-CSRF-Token': client.csrfToken } },
    );
    expect(reread.status()).toBe(409);

    await client.context.close();
  });

  test('E2E-05b: a client requests changes with a note, and the note persists', async ({
    browser,
  }) => {
    const fixture = world().atlas.approval as ApprovalFixture;
    const versionId = fixture.secondDeliverableVersionId;

    const client = await openAs(browser, world().atlas.admin.id);
    await client.page.goto(deepLink(versionId));

    // Requesting changes needs a note; the screen asks for it before sending. Scope to the alert
    // carrying the message: Next renders a second, always-empty `role="alert"` route announcer, so
    // an unfiltered `getByRole('alert')` is a strict-mode collision rather than the field error.
    await client.page.getByRole('button', { name: 'Request changes' }).click();
    await expect(client.page.getByRole('alert').filter({ hasText: 'Add a note' })).toContainText(
      'Add a note',
    );

    await client.page
      .getByLabel(/A note for/)
      .fill('Please soften the headline before we sign off.');
    await client.page.getByRole('button', { name: 'Request changes' }).click();

    await expect(client.page.getByText('You requested changes')).toBeVisible();
    await expect(
      client.page.getByText('Please soften the headline before we sign off.'),
    ).toBeVisible();

    await client.context.close();
  });

  test('E2E-05c: a sibling client of the same studio is told nothing exists', async ({
    browser,
  }) => {
    const fixture = world().atlas.approval as ApprovalFixture;
    const meridian = await openAs(browser, world().meridian.reviewer.id);

    await meridian.page.goto(deepLink(fixture.deliverableVersionId));
    // The projection is not theirs: the same not-found a version that never existed would give,
    // carrying nothing of it.
    await expect(meridian.page.getByText('Could not open this deliverable')).toBeVisible();
    await expect(meridian.page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await meridian.context.close();
  });
});
