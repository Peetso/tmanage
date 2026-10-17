import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * ADM-POL — the administrator's access-policy editor (x174) and its effect through the policy
 * simulator (x196), driven through a real browser against the real stack.
 *
 * The API's guards are proved exhaustively in the controller/service suites
 * (`apps/api/src/modules/admin/policies.controller.test.ts` and `policy-simulate.service.test.ts`);
 * this journey proves the two screens and their routes carry an administrator through the loop the
 * audit named — *store an access policy, then see the effect of the stored roles and policies on a
 * specific member* — and that the refusals a non-administrator and an out-of-range value earn reach
 * the person as a message rather than a silent no-op.
 *
 * The two surfaces are joined on purpose: x174 lets an owner write the organization's access policy,
 * and x196 answers the question that policy exists to inform — *would this member be allowed to do
 * this?* — with the deciding rule made explicit, using the very same evaluator the request path uses.
 *
 * Fresh stack per run (`globalSetup`), `retries: 0`, one worker: the edit writes the org-wide policy
 * document and does not restore it, so a serial retry would replay against a policy that has already
 * moved. The simulator is read-only and leaves nothing changed.
 */

const ORG_SLUG = 'northstar-studio';

interface SeededUser {
  readonly id: string;
  readonly membershipId: string;
  readonly displayName: string;
}

interface World {
  readonly northstar: {
    readonly projectId: string;
    /** Maya — owner, org-wide scope: holds `org.manage`, so she is the administrator here. */
    readonly owner: SeededUser;
    /** Lina — a plain `member` and a member of `projectId`: she holds no `org.manage`. */
    readonly designer: SeededUser;
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

async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await signIn(context, userId);
  const page = await context.newPage();
  return { context, page };
}

const policiesUrl = `/${ORG_SLUG}/policies`;
const simulateUrl = `/${ORG_SLUG}/policies/simulate`;

test.describe.serial('the admin access-policy and simulation journeys', () => {
  test('E2E-ADM-POL-01a: an owner edits the access policy and the change persists', async ({
    browser,
  }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(policiesUrl);

    // The screen seeds its fields from the stored document, which starts at the defaults (24 hours,
    // no domains, no guest access) before anyone has written a policy.
    const sessionField = admin.page.getByLabel('Session lifetime (hours)');
    await expect(sessionField).toHaveValue('24');

    // Edit all three typed policies and save. A whole, valid document is sent and accepted.
    await sessionField.fill('168');
    await admin.page.getByLabel('Invite domain allowlist').fill('studio.example, team.example');
    await admin.page.getByRole('button', { name: 'Save' }).click();
    await expect(
      admin.page.getByText('The access policy has been updated for the whole organization.'),
    ).toBeVisible();

    // The effect: a fresh load of the page reads the written document back, not the defaults.
    await admin.page.goto(policiesUrl);
    await expect(admin.page.getByLabel('Session lifetime (hours)')).toHaveValue('168');
    await expect(admin.page.getByLabel('Invite domain allowlist')).toHaveValue(
      'studio.example, team.example',
    );

    await admin.context.close();
  });

  test('E2E-ADM-POL-01b: an out-of-range session lifetime is refused, with no write', async ({
    browser,
  }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(policiesUrl);

    // 999 hours is past the one-month ceiling the allowlist validator enforces. The form submits
    // (it carries `noValidate`), the API refuses the whole document with a 400, and the screen
    // surfaces that rather than swallowing it.
    await admin.page.getByLabel('Session lifetime (hours)').fill('999');
    await admin.page.getByRole('button', { name: 'Save' }).click();
    await expect(admin.page.getByText('Could not save the access policy')).toBeVisible();

    // No write: a reload still reads back the value the previous journey saved, not 999.
    await admin.page.goto(policiesUrl);
    await expect(admin.page.getByLabel('Session lifetime (hours)')).toHaveValue('168');

    await admin.context.close();
  });

  test('E2E-ADM-POL-01c: a member without org.manage cannot load the access policy', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.designer.id);
    await member.page.goto(policiesUrl);

    // The GET sits behind `org.manage`, which a plain member does not hold; the API answers 403 and
    // the screen renders the refusal rather than an empty form.
    await expect(member.page.getByText('Could not load the access policy')).toBeVisible();
    await expect(member.page.getByLabel('Session lifetime (hours)')).toHaveCount(0);

    await member.context.close();
  });

  test('E2E-ADM-SIM-02a: simulating the owner for org.manage is Allowed', async ({ browser }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(simulateUrl);

    // The screen's own readiness signal, not a sleep: the form ships disabled and enables only once
    // React has hydrated (the standing barrier `useHydrated` documents). Without it, on a cold
    // compile the Simulate click below can land before the submit handler exists and be lost,
    // leaving the screen with neither a result nor an error.
    await expect(admin.page.getByLabel('Member id')).toBeEnabled();

    await admin.page.getByLabel('Member id').fill(world().northstar.owner.membershipId);
    await admin.page.getByLabel('Capability').selectOption('org.manage');
    await admin.page.getByRole('button', { name: 'Simulate' }).click();

    // The decision is the live evaluator's: an owner holds `org.manage`, so the deciding rule is the
    // owner role itself.
    await expect(admin.page.getByText('Allowed')).toBeVisible();
    await expect(admin.page.getByText('role:owner')).toBeVisible();

    await admin.context.close();
  });

  test('E2E-ADM-SIM-02b: simulating a member for org.manage is Denied', async ({ browser }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(simulateUrl);

    // Wait for the form to hydrate before interacting (see SIM-02a).
    await expect(admin.page.getByLabel('Member id')).toBeEnabled();

    await admin.page.getByLabel('Member id').fill(world().northstar.designer.membershipId);
    await admin.page.getByLabel('Capability').selectOption('org.manage');
    await admin.page.getByRole('button', { name: 'Simulate' }).click();

    // A plain member's role ceiling does not include `org.manage`, so the same evaluator denies it —
    // the effect of the role on the decision, shown without granting anything. The result names the
    // role it evaluated (member) and, for a deny, the evaluator's own deciding rule rather than a
    // role grant.
    await expect(admin.page.getByText('Denied')).toBeVisible();
    await expect(admin.page.getByText(/Role\s+member/)).toBeVisible();

    await admin.context.close();
  });

  test('E2E-ADM-SIM-02c: simulating a member for work.read on their own project is Allowed', async ({
    browser,
  }) => {
    const admin = await openAs(browser, world().northstar.owner.id);
    await admin.page.goto(simulateUrl);

    // Wait for the form to hydrate before interacting (see SIM-02a).
    await expect(admin.page.getByLabel('Member id')).toBeEnabled();

    // The designer is a member of this project, so at project scope the relation check passes and her
    // `member` role carries `work.read`. The same capability at the org level would not resolve — the
    // project context is what the evaluator weighs here.
    await admin.page.getByLabel('Member id').fill(world().northstar.designer.membershipId);
    await admin.page.getByLabel('Capability').selectOption('work.read');
    await admin.page.getByLabel('Project id (optional)').fill(world().northstar.projectId);
    await admin.page.getByRole('button', { name: 'Simulate' }).click();

    await expect(admin.page.getByText('Allowed')).toBeVisible();
    await expect(admin.page.getByText('role:member')).toBeVisible();

    await admin.context.close();
  });
});
