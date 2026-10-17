import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * Automations & integrations (module 17), through a real browser against the real stack.
 *
 * **AUTO-01 / AUTO-02, "Automations create and run"** — an org admin defines a workflow
 * template on the automations screen, runs it, and reads the outcome back from the run-history
 * screen. The journey joins three real surfaces the module ships:
 *
 *   - the templates screen (`[orgSlug]/automations`, x162) — a define form and the org's list;
 *   - the run endpoint (`…/automations/templates/:id/run`, x163) — the one execution path;
 *   - the run-history screen (`[orgSlug]/automations/runs`, x164) — the append-only record.
 *
 * ## Why the run leg goes through the API, not a button
 *
 * `AutomationRunButton` exists (x163) but is wired into no page today — the templates screen's
 * own docstring says "Nothing runs here". So the only way a person makes a template run in the
 * shipped product is the HTTP route the button would call. This journey calls that route the way
 * the browser would — the signed-in session cookie, the CSRF header, the real `Origin` — so what
 * it exercises is the deployed request, not a test shortcut, and then verifies the *outcome*
 * through the real history screen a person would open. When a run control gains a page, the run
 * legs here should drive it instead of the route.
 *
 * ## Who signs in
 *
 * Every automation route is gated on `org.manage`, and the permission matrix grants that
 * capability to the `owner` role alone (`org_admin` is explicitly short of it). So the journey
 * signs in as Northstar's owner; a lesser role would be refused by the API before any of this
 * could be observed, which is a different journey.
 *
 * ## What this file leaves behind
 *
 * It defines templates and records runs under Northstar and does not remove them — reversing a
 * journey is not a journey. No other spec touches the automations tables, and `globalSetup` gives
 * every run a fresh stack, so the history this journey reads is only ever its own. `retries` must
 * stay at 0: the cases are serial and each builds on the row the last one wrote.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
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

/**
 * The browser's own CSRF header, read from the session's cookie jar. A write sent without it would
 * be refused by the CSRF guard rather than the route under test, so a run or create that is *meant*
 * to succeed carries it, exactly as the app's fetch client does.
 */
async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const csrf = (await context.cookies(API_URL)).find(
    (cookie) => cookie.name === 'tmanage_session_csrf',
  );
  expect(csrf?.value).toBeTruthy();
  return { 'x-csrf-token': csrf?.value as string, origin: WEB_URL };
}

const ORG = 'northstar-studio';

function templatesPath(): string {
  return `${API_URL}/v1/organizations/${ORG}/automations/templates`;
}

interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
  readonly enabled: boolean;
}

interface RunView {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
}

interface RunErrorBody {
  readonly error: { readonly code: string };
}

/** Read the acting tenant's templates and return the one with this exact name. */
async function templateIdByName(context: BrowserContext, name: string): Promise<string> {
  const response = await context.request.get(templatesPath());
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { templates: readonly TemplateView[] };
  const match = body.templates.find((template) => template.name === name);
  expect(match, `no template named ${name}`).toBeTruthy();
  return (match as TemplateView).id;
}

const IN_APP_NAME = 'E2E notify owner on new work';
const EXTERNAL_NAME = 'E2E email digest on publish';
const DISABLED_NAME = 'E2E disabled notify owner';

/** Set in AUTO-01a / AUTO-01c, read by the run legs. */
let inAppTemplateId = '';
let externalTemplateId = '';

test.describe.serial('the automations create-and-run journey', () => {
  test('AUTO-01a: the owner defines an in-app template through the screen and sees it listed', async ({
    browser,
  }) => {
    const owner = await openAs(browser, world().northstar.owner.id);
    await owner.page.goto(`/${ORG}/automations`);

    // The define form, with its defaults: the first trigger and the first action, which is the
    // in-app `notify_owner` the run leg below will execute. Only the name has to be supplied.
    // The form ships disabled until React hydrates (useHydrated); wait for that readiness signal.
    await expect(owner.page.getByLabel('Name')).toBeEnabled();
    await owner.page.getByLabel('Name').fill(IN_APP_NAME);
    await expect(owner.page.getByLabel('Trigger')).toHaveValue('work_item_created');
    await expect(owner.page.getByLabel('Action')).toHaveValue('notify_owner');
    await owner.page.getByRole('button', { name: 'Create template' }).click();

    // The new row, in the list the same screen renders. Asserted about this template's row rather
    // than the table at large, and by the human labels the screen shows rather than the stored
    // tokens: trigger and action are humanized, and a fresh template is enabled.
    const row = owner.page.getByRole('row').filter({ hasText: IN_APP_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Work item created');
    await expect(row).toContainText('Notify owner');
    await expect(row).toContainText('Enabled');

    inAppTemplateId = await templateIdByName(owner.context, IN_APP_NAME);

    await owner.context.close();
  });

  test('AUTO-01b: the define form will not submit an empty or whitespace-only name', async ({
    browser,
  }) => {
    const owner = await openAs(browser, world().northstar.owner.id);
    await owner.page.goto(`/${ORG}/automations`);

    // On a fresh load the name is empty, so the control is genuinely unavailable (the `disabled`
    // attribute, not merely `aria-disabled`): there is nothing to create.
    const createButton = owner.page.getByRole('button', { name: 'Create template' });
    await expect(createButton).toBeDisabled();

    // Whitespace is not a name — the screen trims before it decides, so a space-only field stays
    // unavailable rather than letting a blank template through to the API's 400.
    // The form ships disabled until React hydrates (useHydrated); wait for that readiness signal.
    await expect(owner.page.getByLabel('Name')).toBeEnabled();
    await owner.page.getByLabel('Name').fill('   ');
    await expect(createButton).toBeDisabled();

    // A real name re-enables it; this case does not submit — AUTO-01a already owns the create.
    await owner.page.getByLabel('Name').fill('A real name');
    await expect(createButton).toBeEnabled();

    await owner.context.close();
  });

  test('AUTO-01c: the owner defines an external-action template through the screen', async ({
    browser,
  }) => {
    const owner = await openAs(browser, world().northstar.owner.id);
    await owner.page.goto(`/${ORG}/automations`);

    // A document-published trigger paired with the external `send_email_digest` action — the kind
    // the run service refuses to execute in-app. The screen offers it; the run leg proves it fails
    // closed rather than reaching the network.
    // The form ships disabled until React hydrates (useHydrated); wait for that readiness signal.
    await expect(owner.page.getByLabel('Name')).toBeEnabled();
    await owner.page.getByLabel('Name').fill(EXTERNAL_NAME);
    await owner.page.getByLabel('Trigger').selectOption('document_published');
    await owner.page.getByLabel('Action').selectOption('send_email_digest');
    await owner.page.getByRole('button', { name: 'Create template' }).click();

    const row = owner.page.getByRole('row').filter({ hasText: EXTERNAL_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Document published');
    await expect(row).toContainText('Send email digest');
    await expect(row).toContainText('Enabled');

    externalTemplateId = await templateIdByName(owner.context, EXTERNAL_NAME);

    await owner.context.close();
  });

  test('AUTO-02a: running the in-app template records a succeeded run the history screen shows', async ({
    browser,
  }) => {
    expect(inAppTemplateId).not.toBe('');
    const owner = await openAs(browser, world().northstar.owner.id);

    // The run, as the browser would send it. The outcome is asserted from the response body, not
    // inferred from the screen: an in-app action succeeds and its detail names the effect it carried
    // out inside the app.
    const response = await owner.context.request.post(`${templatesPath()}/${inAppTemplateId}/run`, {
      headers: await csrfHeaders(owner.context),
    });
    expect(response.status()).toBe(201);
    const run = (await response.json()) as RunView;
    expect(run.status).toBe('succeeded');
    expect(run.detail['effect']).toBe('Notified the work owner in-app.');

    // The record, read back through the screen a person opens. The row is found by its template id
    // (the history list keys rows on the id, not the name), newest-first.
    await owner.page.goto(`/${ORG}/automations/runs`);
    const row = owner.page.getByRole('row').filter({ hasText: inAppTemplateId });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Succeeded');

    // The detail drawer reads the run's full detail on demand — the effect the response promised,
    // now shown to the reader.
    await row.getByRole('button', { name: 'View details' }).click();
    const detail = owner.page.getByRole('complementary', { name: 'Run detail' });
    await expect(detail).toContainText('Succeeded');
    await expect(detail).toContainText('Notified the work owner in-app.');

    await owner.context.close();
  });

  test('AUTO-02b: running the external-action template records a failed run, and the filters agree', async ({
    browser,
  }) => {
    expect(externalTemplateId).not.toBe('');
    const owner = await openAs(browser, world().northstar.owner.id);

    // The external action is refused in-app: the run is still recorded (it is auditable), but as a
    // failure whose detail names why, and no delivery is attempted.
    const response = await owner.context.request.post(
      `${templatesPath()}/${externalTemplateId}/run`,
      { headers: await csrfHeaders(owner.context) },
    );
    expect(response.status()).toBe(201);
    const run = (await response.json()) as RunView;
    expect(run.status).toBe('failed');
    expect(run.detail['reason']).toBe('external_action_not_supported_in_app');

    await owner.page.goto(`/${ORG}/automations/runs`);

    // The status filter offers only the allowlisted outcomes. Under "Failed" the external run is
    // present and the earlier succeeded run is gone; under "Succeeded" the two swap. The claim is
    // about each template's own row, so another journey's runs — there are none — would not confuse it.
    // The filter ships disabled until React hydrates (useHydrated); wait for that readiness signal.
    await expect(owner.page.getByLabel('Status')).toBeEnabled();
    await owner.page.getByLabel('Status').selectOption('failed');
    await expect(owner.page.getByRole('row').filter({ hasText: externalTemplateId })).toBeVisible();
    await expect(owner.page.getByRole('row').filter({ hasText: inAppTemplateId })).toHaveCount(0);

    await owner.page.getByLabel('Status').selectOption('succeeded');
    await expect(owner.page.getByRole('row').filter({ hasText: inAppTemplateId })).toBeVisible();
    await expect(owner.page.getByRole('row').filter({ hasText: externalTemplateId })).toHaveCount(
      0,
    );

    await owner.context.close();
  });

  test('AUTO-02c: a disabled template cannot be run, and nothing is recorded for it', async ({
    browser,
  }) => {
    const owner = await openAs(browser, world().northstar.owner.id);

    // A disabled template — the screen only ever creates enabled ones, so this is defined through the
    // API the same way the browser would (session cookie, CSRF header, real origin).
    const created = await owner.context.request.post(templatesPath(), {
      headers: await csrfHeaders(owner.context),
      data: {
        name: DISABLED_NAME,
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: {},
        enabled: false,
      },
    });
    expect(created.status()).toBe(201);
    const disabledTemplateId = ((await created.json()) as TemplateView).id;

    // The run is refused with a conflict, not attempted: a disabled template has no outcome.
    const refused = await owner.context.request.post(
      `${templatesPath()}/${disabledTemplateId}/run`,
      { headers: await csrfHeaders(owner.context) },
    );
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as RunErrorBody).error.code).toBe('conflict');

    // And the refusal left no trace: the history screen, unfiltered, never names this template.
    await owner.page.goto(`/${ORG}/automations/runs`);
    await expect(owner.page.getByRole('region', { name: 'Runs', exact: true })).toBeVisible();
    await expect(owner.page.getByRole('row').filter({ hasText: disabledTemplateId })).toHaveCount(
      0,
    );

    await owner.context.close();
  });
});
