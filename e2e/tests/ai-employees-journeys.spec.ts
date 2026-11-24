import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';
import { LANGS, expectLanguage, inLang, seedWorld, test, word } from '../setup/journey-kit.js';
import type { Lang } from '../setup/journey-kit.js';

/**
 * Plan 60 v2, slice 60-10 — the Phase 1 ship gate, in English and in Arabic: an AI employee can
 * be hired, connected, paused and retired, and he can do nothing else yet.
 *
 * - **AIE-01** — the owner opens People, chooses Add › Hire an AI employee and fills the wizard
 *   (who, then work: one project, she sponsors him). The hire is saved when the work step is
 *   left. On Connect she picks "Other agent or tool" and creates an agent key, shown once. A
 *   scripted test agent — plain HTTP with that key, as any agent would hold it — makes the first
 *   call of every run, `agent_whoami` (`GET …/agent/me`): it answers his name, job title, sponsor
 *   and his one project. The wizard's Test step sees the call and says he is ready. The same key
 *   reaches nothing outside the agent contract (a project list, `/mcp`): 403. Paused from his
 *   profile, `agent_whoami` is refused; resumed, it answers again; retired, it is refused for good,
 *   the profile says Retired and his agent key is marked revoked.
 *
 * The twin workspace, so Northstar's People stay as the other journeys expect them. Each language
 * hires its own AI employee (the beta allows five per workspace), so the two runs never share one.
 */

interface World {
  readonly twin: {
    readonly projectName: string;
    readonly owner: { readonly id: string; readonly displayName: string };
  };
}

const TWIN = 'northstar-studios';
const world = (): World => seedWorld<World>();

/** Each run's AI employee: his name and job title as the owner types them. */
const HIRE: Readonly<Record<Lang, { readonly name: string; readonly jobTitle: string }>> = {
  en: { name: 'Mat', jobTitle: 'Social media designer' },
  ar: { name: 'زياد', jobTitle: 'مصمم سوشيال ميديا' },
};

interface WhoamiView {
  readonly contract: string;
  readonly name: string;
  readonly jobTitle: string;
  readonly sponsor: { readonly membershipId: string; readonly name: string | null };
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

/**
 * The scripted test agent: it holds only its agent key and calls the agent contract over HTTP,
 * with no cookie and no browser, the way an agent runtime does.
 */
function scriptedAgent(request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  return {
    whoami: () => request.get(`${API_URL}/v1/organizations/${TWIN}/agent/me`, { headers }),
    projects: () => request.get(`${API_URL}/v1/organizations/${TWIN}/projects`, { headers }),
    mcpToolList: () =>
      request.post(`${API_URL}/mcp`, {
        headers: { ...headers, accept: 'application/json, text/event-stream' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      }),
  };
}

async function expectRefused(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.status(), await response.text()).toBe(403);
  const body = (await response.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe('forbidden');
}

/** Wizard step 1 (who) and step 2 (work); leaving step 2 saves the hire. */
async function hire(page: Page, lang: Lang): Promise<void> {
  const { name, jobTitle } = HIRE[lang];
  const chooser = page.getByRole('dialog');
  const hireCard = chooser.getByText(word(lang, 'AiPeople.hireAi'), { exact: true });
  // A cold dev server can paint Add before React has hydrated it; press again until it opens.
  await expect(async () => {
    if (!(await hireCard.isVisible())) {
      await page.getByRole('button', { name: word(lang, 'AiPeople.add'), exact: true }).click();
    }
    await expect(hireCard).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  // The card turns on once the AI-employee list has loaded (the beta count under it).
  await expect(
    chooser.getByRole('radio', { name: new RegExp(word(lang, 'AiPeople.hireAi'), 'u') }),
  ).toBeEnabled();
  await hireCard.click();
  await chooser.getByRole('button', { name: word(lang, 'AiPeople.continue'), exact: true }).click();

  const wizard = page.getByRole('dialog');
  await wizard.getByLabel(word(lang, 'AiWizard.name'), { exact: true }).fill(name);
  await wizard.getByLabel(word(lang, 'AiPeople.colJobTitle'), { exact: true }).fill(jobTitle);
  await wizard.getByRole('button', { name: word(lang, 'AiWizard.next'), exact: true }).click();

  // Work: the role stays Member and she stays the sponsor; he may work in one project.
  const projects = wizard.getByRole('combobox', { name: word(lang, 'AiWizard.projects') });
  await projects.click();
  await page.getByRole('option', { name: world().twin.projectName, exact: true }).click();
  await expect(
    wizard.getByRole('button', {
      name: word(lang, 'AiWizard.removeProject', { name: world().twin.projectName }),
    }),
  ).toBeVisible();
  await wizard.getByRole('button', { name: word(lang, 'AiWizard.next'), exact: true }).click();
}

/** Wizard step 3 (connect): an agent key for "Other agent or tool", read once from the page. */
async function createAgentKey(page: Page, lang: Lang): Promise<string> {
  const wizard = page.getByRole('dialog');
  await wizard.getByText(word(lang, 'AiConnect.other'), { exact: true }).click();
  await wizard
    .getByRole('button', { name: word(lang, 'AiConnect.createKey'), exact: true })
    .click();
  await expect(wizard.getByText(word(lang, 'AiConnect.copyNow'))).toBeVisible();
  const token = await wizard
    .getByLabel(word(lang, 'AiConnect.agentKey'), { exact: true })
    .inputValue();
  expect(token.length).toBeGreaterThan(20);
  return token;
}

for (const lang of LANGS) {
  test(`AIE-01 [${lang}]: hire an AI employee, connect a scripted agent, pause, resume and retire him`, async ({
    request,
    signIn,
  }) => {
    test.setTimeout(300_000);
    const { name, jobTitle } = HIRE[lang];
    const owner = await signIn(world().twin.owner.id, { member: { org: TWIN, lang } });
    const { page, context } = owner;

    await page.goto(inLang(`/${TWIN}/people`, lang));
    await expectLanguage(page, lang);

    // ---- hire ----
    await hire(page, lang);

    // ---- connect: an agent key, and the scripted agent's first call ----
    const token = await createAgentKey(page, lang);
    const agent = scriptedAgent(request, token);
    const wizard = page.getByRole('dialog');
    await wizard.getByRole('button', { name: word(lang, 'AiWizard.next'), exact: true }).click();

    const first = await agent.whoami();
    expect(first.status(), await first.text()).toBe(200);
    const me = (await first.json()) as WhoamiView;
    expect(me.contract).toMatch(/^1\.\d+$/u);
    expect(me.name).toBe(name);
    expect(me.jobTitle).toBe(jobTitle);
    expect(me.sponsor.name).toBe(world().twin.owner.displayName);
    expect(me.projects.map((project) => project.name)).toEqual([world().twin.projectName]);

    // The Test step sees the call (it re-reads him every few seconds) and says he is ready.
    await expect(wizard.getByText(word(lang, 'AiTest.ready', { name }))).toBeVisible({
      timeout: 30_000,
    });
    await wizard.getByRole('button', { name: word(lang, 'AiWizard.done'), exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(word(lang, 'AiPeople.hired', { name }))).toBeAttached();

    // He can do nothing else yet: outside the agent contract his key is refused.
    await expectRefused(await agent.projects());
    expect((await agent.mcpToolList()).status()).toBe(403);

    // ---- his profile, from People ----
    await page.getByRole('link', { name, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/${TWIN}/people/[0-9a-f-]{36}`, 'u'));
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

    // ---- pause stops him ----
    await page.getByRole('button', { name: word(lang, 'AiProfile.pause'), exact: true }).click();
    await expect(
      page.getByRole('button', { name: word(lang, 'AiProfile.resume'), exact: true }),
    ).toBeVisible();
    await expectRefused(await agent.whoami());

    // ---- resume lets him back in ----
    await page.getByRole('button', { name: word(lang, 'AiProfile.resume'), exact: true }).click();
    await expect(
      page.getByRole('button', { name: word(lang, 'AiProfile.pause'), exact: true }),
    ).toBeVisible();
    const back = await agent.whoami();
    expect(back.status(), await back.text()).toBe(200);

    // ---- retire: his connections stop at once, and he stays in People as Retired ----
    await page
      .getByRole('button', { name: word(lang, 'AiProfile.moreFor', { name }), exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: word(lang, 'AiProfile.retireNamed', { name }) })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: word(lang, 'AiProfile.retireNamed', { name }), exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByText(word(lang, 'AiPeople.status.retired'), { exact: true }).first(),
    ).toBeVisible();
    // Retired, his membership is offboarded and his key is revoked: the key itself is dead, so it
    // gets the 401 any unknown or revoked key gets (no hint that he ever existed), on every route.
    const after = await agent.whoami();
    expect(after.status(), await after.text()).toBe(401);
    expect(((await after.json()) as { error?: { code?: string } }).error?.code).toBe(
      'unauthenticated',
    );

    // And the rows say so: retire marked his key revoked (not only his membership offboarded),
    // so nothing re-opening the membership could wake it. Read with the owner's own session.
    const base = `${API_URL}/v1/organizations/${TWIN}`;
    const listed = await context.request.get(`${base}/ai-employees`);
    expect(listed.status(), await listed.text()).toBe(200);
    const him = (
      (await listed.json()) as { aiEmployees: { id: string; displayName: string }[] }
    ).aiEmployees.find((row) => row.displayName === name);
    expect(him).toBeDefined();
    const keys = await context.request.get(`${base}/ai-employees/${him?.id ?? ''}/keys`);
    expect(keys.status(), await keys.text()).toBe(200);
    const keyList = (await keys.json()) as {
      keys: { revokedAt: string | null; live: boolean }[];
      live: number;
    };
    expect(keyList.keys.length).toBeGreaterThan(0);
    expect(keyList.keys.every((key) => key.revokedAt !== null && !key.live)).toBe(true);
    expect(keyList.live).toBe(0);
  });
}
