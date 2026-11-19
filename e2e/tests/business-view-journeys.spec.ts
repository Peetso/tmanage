import { expect } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { API_URL, WEB_URL, runBusinessViewJob } from '../setup/stack.js';
import {
  LANGS,
  databaseUrl,
  expectLanguage,
  inLang,
  platformStepUp,
  seedWorld,
  test,
  word,
} from '../setup/journey-kit.js';
import type { Lang, SignedIn } from '../setup/journey-kit.js';

/**
 * T2 (pass 2026-11-19, BATCH-2026-11-19 §6) — "the business view", in English and in Arabic:
 *
 * - **BV-01 project one page → Activity** — the owner opens a project: the Overview blocks (Money
 *   among them), then the Activity tab, which the projector filled from the audit trail; the Kind,
 *   Person and Date filters narrow it and Clear filters puts it back.
 * - **BV-02 client page → Activity** — the same on the client company's page, each row naming its
 *   project.
 * - **BV-03 a member without finance** — no Money block, no Money filter and no finance entry,
 *   on the same project where the owner sees all three.
 * - **BV-04 alerts → Home briefing** — the owner turns the business briefing on (Modules), saves an
 *   alert rule (Settings → Alerts), the hourly sweep runs over a late task, Home shows the line
 *   under its group, the line opens the task, and Hide from Home takes the card away for good.
 * - **BV-05 a lead sees only their projects** — the manager's briefing lists the late task of a
 *   project they lead and not the one of a project they are not on; the owner's lists both.
 * - **BV-06 a client sees none of it** — with the briefing on, the briefing answers the client 404
 *   and the staff screens' reads stop it at their ceiling, the same as for an id that does not
 *   exist (the owner 200 on the same addresses); the portal draws no briefing and no Activity.
 * - **BV-07 Growth tiles** — Platform admin → Growth shows the 62-A3 figures, each in its honest
 *   empty state on a young stack ("No data yet", "Not set", not in the free beta).
 * - **BV-08 public pages say "company"** — facts, compare and an alternative page, without
 *   "agency" (the agencies segment page is the one place that keeps it).
 * - **BV-09 saved Arabic past a CDN** (CDNFIX 37a84f8e) — a cached English page served to a
 *   visitor whose cookie says Arabic: the boot script, not the proxy, moves them to the Arabic twin.
 *
 * The briefing switch is the company's `business_briefing` flag. Every journey that turns it on
 * turns it off again in `finally`, so the journeys after this file see Home as they always did.
 */

interface SeededUser {
  readonly id: string;
  readonly displayName: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
  readonly atlas: { readonly clientOrganizationId: string; readonly admin: SeededUser };
  readonly meridian: { readonly projectId: string };
  readonly platformAdmin: { readonly id: string; readonly password: string };
}

const NORTHSTAR = 'northstar-studio';
const ORG_API = `${API_URL}/v1/organizations/${NORTHSTAR}`;
const ALERT_RULES = `${ORG_API}/insights/signal-settings`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A well-formed id no record has. */
const MISSING_ID = '01999999-9999-7999-8999-999999999999';
/** Far enough past due to be the most pressing line of its group (three lines are drawn). */
const LATE_DAYS = 45;

const world = (): World => seedWorld<World>();

/** A title no other journey uses, so a row or a line found by it is this run's. */
const unique = (label: string, lang: Lang): string => `${label} ${lang} ${Date.now()}`;

async function ok(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<unknown> {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.status() === 204 ? null : ((await response.json()) as unknown);
}

/**
 * A journey's undo steps, every one run even when one before it fails. A failed step is a soft
 * expect: reported, without replacing the error that ended the journey (a throw in `finally` would).
 */
async function undo(...steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      expect.soft(error, 'a clean-up step failed').toBeUndefined();
    }
  }
}

/** A task on `projectId`, due `daysLate` days ago (the deadline rule's late case). */
async function createTask(
  who: SignedIn,
  projectId: string,
  title: string,
  daysLate = 0,
): Promise<string> {
  const body = (await ok(
    await who.context.request.post(`${ORG_API}/work-items`, {
      headers: who.headers,
      data: {
        projectId,
        title,
        ...(daysLate > 0 ? { dueAt: new Date(Date.now() - daysLate * DAY_MS).toISOString() } : {}),
      },
    }),
  )) as { id: string };
  return body.id;
}

/** The company's `business_briefing` module, through the owner's own Modules route. */
async function setBriefing(who: SignedIn, enabled: boolean): Promise<void> {
  await ok(
    await who.context.request.put(`${ORG_API}/admin/feature-flags/business_briefing`, {
      headers: who.headers,
      data: { enabled },
    }),
  );
}

async function project(): Promise<void> {
  const report = await runBusinessViewJob(databaseUrl(), 'project-activity');
  expect(report['job']).toBe('project-activity');
}

async function sweep(): Promise<void> {
  const report = await runBusinessViewJob(databaseUrl(), 'sweep-signals');
  expect(report['failed']).toBe(0);
  expect(Number(report['organizations'])).toBeGreaterThan(0);
}

/** The Activity feed card (its heading is "Activity", like the tab that opens it). */
const feedOf = (page: Page, lang: Lang): Locator =>
  page.getByRole('region', { name: word(lang, 'ActivityTab.title'), exact: true });

const kindRadio = (page: Page, lang: Lang, kind: string): Locator =>
  page
    .getByRole('radiogroup', { name: word(lang, 'ActivityTab.kindLabel') })
    .getByRole('radio', { name: word(lang, kind), exact: true });

const phrase = (lang: Lang, action: string): string => word(lang, `activity.phrase.${action}`);

/** The kind filter, then the Person and Date menus, then Clear filters — on whichever page. */
async function exerciseFilters(
  page: Page,
  lang: Lang,
  taskId: string,
  ownerName: string,
): Promise<void> {
  const feed = feedOf(page, lang);
  const taskRow = feed.locator(`a[href$="/work/${taskId}"]`);
  const budgetRow = feed.getByText(phrase(lang, 'budget.updated'));
  await expect(taskRow).toBeVisible();
  await expect(budgetRow.first()).toBeVisible();

  // Kind: one choice at a time.
  await kindRadio(page, lang, 'ActivityTab.kind.work').click();
  await expect(kindRadio(page, lang, 'ActivityTab.kind.work')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(taskRow).toBeVisible();
  await expect(budgetRow).toHaveCount(0);
  await kindRadio(page, lang, 'ActivityTab.kind.money').click();
  await expect(budgetRow.first()).toBeVisible();
  await expect(taskRow).toHaveCount(0);
  await kindRadio(page, lang, 'ActivityTab.all').click();
  await expect(taskRow).toBeVisible();

  // Person and Date are menus behind chips (on a desktop they are drawn without the toggle).
  const personChip = page.getByRole('button', {
    name: word(lang, 'ActivityTab.personChip', { name: word(lang, 'ActivityTab.anyone') }),
  });
  await personChip.click();
  await page
    .getByRole('menu', { name: word(lang, 'ActivityTab.person') })
    .getByRole('menuitemradio', { name: ownerName })
    .click();
  await expect(
    page.getByRole('button', { name: word(lang, 'ActivityTab.personChip', { name: ownerName }) }),
  ).toBeVisible();
  await expect(taskRow).toBeVisible();

  await page.getByRole('button', { name: word(lang, 'ActivityTab.period.any') }).click();
  await page
    .getByRole('menu', { name: word(lang, 'ActivityTab.period') })
    .getByRole('menuitemradio', { name: word(lang, 'ActivityTab.period.7') })
    .click();
  await expect(taskRow).toBeVisible();

  await page.getByRole('button', { name: word(lang, 'ActivityTab.clearFilters') }).click();
  await expect(personChip).toBeVisible();
  await expect(budgetRow.first()).toBeVisible();
}

/** What the owner set up for BV-01..03: a task and a budget change on the client's project. */
async function seedActivity(owner: SignedIn, lang: Lang): Promise<string> {
  const taskId = await createTask(
    owner,
    world().northstar.projectId,
    unique('Activity task', lang),
  );
  await ok(
    await owner.context.request.put(`${ORG_API}/projects/${world().northstar.projectId}/budget`, {
      headers: owner.headers,
      data: { budgetHours: 400 },
    }),
  );
  await project();
  return taskId;
}

for (const lang of LANGS) {
  test.describe(`the business view [${lang}]`, () => {
    test(`BV-01 [${lang}]: the owner's project page, its Activity tab and the filters`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id, { member: { org: NORTHSTAR, lang } });
      const taskId = await seedActivity(owner, lang);
      const { page } = owner;

      await page.goto(`/${NORTHSTAR}/projects/${world().northstar.projectId}`);
      await expectLanguage(page, lang);
      for (const block of ['Overview.delivery', 'Overview.risks', 'Overview.money']) {
        await expect(
          page.getByRole('region', { name: word(lang, block), exact: true }),
        ).toBeVisible();
      }

      const tabs = page.getByRole('navigation', { name: word(lang, 'Overview.tabsLabel') });
      await tabs.getByRole('link', { name: word(lang, 'ActivityTab.tab'), exact: true }).click();
      await expect(page).toHaveURL(/[?&]view=activity/u);
      await expect(
        tabs.getByRole('link', { name: word(lang, 'ActivityTab.tab'), exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await exerciseFilters(page, lang, taskId, world().northstar.owner.displayName);
    });

    test(`BV-02 [${lang}]: the client page, its Activity tab and the filters`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id, { member: { org: NORTHSTAR, lang } });
      const taskId = await seedActivity(owner, lang);
      const { page } = owner;

      await page.goto(`/${NORTHSTAR}/clients/${world().atlas.clientOrganizationId}`);
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('region', { name: word(lang, 'Overview.delivery'), exact: true }),
      ).toBeVisible();

      const tabs = page.getByRole('navigation', { name: word(lang, 'Overview.tabsLabel') });
      await tabs.getByRole('link', { name: word(lang, 'ActivityTab.tab'), exact: true }).click();
      await expect(page).toHaveURL(/[?&]view=activity/u);
      // A client feed spans the client's projects, so each row names the one it happened on.
      const taskRow = feedOf(page, lang).locator(`a[href$="/work/${taskId}"]`);
      await expect(taskRow).toContainText(world().northstar.projectName);
      await exerciseFilters(page, lang, taskId, world().northstar.owner.displayName);
    });

    test(`BV-03 [${lang}]: a member without finance sees no Money block and no finance entry`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id);
      const taskId = await seedActivity(owner, lang);
      // The same project, read by the owner: the money block and the budget entry are there.
      const summaryUrl = `${ORG_API}/projects/${world().northstar.projectId}/summary`;
      const activityUrl = `${ORG_API}/projects/${world().northstar.projectId}/activity`;
      const ownerSummary = (await ok(await owner.context.request.get(summaryUrl))) as object;
      expect(ownerSummary).toHaveProperty('money');
      const ownerFeed = (await ok(await owner.context.request.get(activityUrl))) as {
        entries: { action: string }[];
      };
      expect(ownerFeed.entries.some((entry) => entry.action === 'budget.updated')).toBe(true);
      await owner.close();

      const member = await signIn(world().northstar.designer.id, {
        member: { org: NORTHSTAR, lang },
      });
      const { page } = member;
      const memberSummary = (await ok(await member.context.request.get(summaryUrl))) as object;
      expect(memberSummary).not.toHaveProperty('money');
      const memberFeed = (await ok(await member.context.request.get(activityUrl))) as {
        entries: { action: string; kind: string }[];
      };
      expect(memberFeed.entries.some((entry) => entry.kind === 'money')).toBe(false);

      await page.goto(`/${NORTHSTAR}/projects/${world().northstar.projectId}`);
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('region', { name: word(lang, 'Overview.delivery'), exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: word(lang, 'Overview.money'), exact: true }),
      ).toHaveCount(0);

      await page.goto(`/${NORTHSTAR}/projects/${world().northstar.projectId}?view=activity`);
      const feed = feedOf(page, lang);
      await expect(feed.locator(`a[href$="/work/${taskId}"]`)).toBeVisible();
      await expect(kindRadio(page, lang, 'ActivityTab.kind.work')).toBeVisible();
      await expect(kindRadio(page, lang, 'ActivityTab.kind.money')).toHaveCount(0);
      await expect(feed.getByText(phrase(lang, 'budget.updated'))).toHaveCount(0);
    });

    test(`BV-04 [${lang}]: alerts on, the sweep runs, Home groups the line, it opens, Hide`, async ({
      signIn,
    }) => {
      test.setTimeout(300_000);
      const owner = await signIn(world().northstar.owner.id, { member: { org: NORTHSTAR, lang } });
      const { page, context, headers } = owner;
      const prefsUrl = `${ORG_API}/home/widget-prefs`;
      const prefsBefore = await ok(await context.request.get(prefsUrl));
      let rulesBefore: unknown = null;
      const tasks: string[] = [];
      try {
        // Modules: the owner turns the business briefing on.
        await page.goto(`/${NORTHSTAR}/admin/feature-flags`);
        await expectLanguage(page, lang);
        const briefingModule = page.getByRole('switch', {
          name: word(lang, 'FeatureFlags.businessBriefing'),
        });
        await expect(briefingModule).toBeEnabled();
        await expect(briefingModule).not.toBeChecked();
        // The switch follows the saved flag (it turns once the save answers), so `check()`, which
        // wants the state at once, would fail on a slow save: click, then wait for the save.
        const flagSaved = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            response.url().endsWith('/admin/feature-flags/business_briefing'),
        );
        await briefingModule.click();
        expect((await flagSaved).ok()).toBe(true);
        await expect(briefingModule).toBeChecked();
        rulesBefore = await ok(await context.request.get(ALERT_RULES));

        // Settings → Alerts: one rule's threshold, saved, still there after a reload.
        await page.goto(`/${NORTHSTAR}/settings/alerts`);
        const rule = word(lang, 'AlertSettings.rule.deadline_at_risk');
        const threshold = page.getByRole('spinbutton', {
          name: word(lang, 'AlertSettings.fieldLabel', {
            rule,
            column: word(lang, 'AlertSettings.columnThreshold'),
          }),
        });
        await expect(page.getByRole('switch', { name: rule })).toBeChecked();
        await threshold.fill('7');
        await page.getByRole('button', { name: word(lang, 'AlertSettings.save') }).click();
        await expect(page.getByText(word(lang, 'AlertSettings.saved'))).toBeVisible();
        await page.reload();
        await expect(threshold).toHaveValue('7');

        // A task well past due (the most pressing deadline line comes first), then the sweep.
        const title = unique('Late hand-off', lang);
        const taskId = await createTask(owner, world().northstar.projectId, title, LATE_DAYS);
        tasks.push(taskId);
        await sweep();

        await page.goto(`/${NORTHSTAR}/home`);
        const card = page.getByRole('region', { name: word(lang, 'HomeBriefing.title') });
        await expect(card).toBeVisible();
        await expect(card.getByText(word(lang, 'HomeBriefing.leadCompany'))).toBeVisible();
        const group = card.locator('[data-group="projects_at_risk"]');
        await expect(
          group.getByRole('heading', { name: word(lang, 'HomeBriefing.group.projects_at_risk') }),
        ).toBeVisible();
        const line = group.getByRole('link', { name: new RegExp(escape(title), 'u') });
        await expect(line).toBeVisible();

        await line.click();
        await expect(page).toHaveURL(new RegExp(`/${NORTHSTAR}/work/${taskId}$`, 'u'));
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

        await page.goto(`/${NORTHSTAR}/home`);
        await expect(card).toBeVisible();
        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' && response.url().endsWith('/home/widget-prefs'),
          { timeout: 30_000 },
        );
        await card.getByRole('button', { name: word(lang, 'HomeBriefing.hide') }).click();
        await expect(page.getByText(word(lang, 'HomeBriefing.hidden'))).toBeVisible();
        await expect(card).toHaveCount(0);
        expect((await saved).ok()).toBe(true);
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(card).toHaveCount(0);
      } finally {
        await undo(
          async () => ok(await context.request.put(prefsUrl, { headers, data: prefsBefore })),
          async () => (rulesBefore === null ? null : restoreAlertRules(owner, rulesBefore)),
          () => deleteTasks(owner, tasks),
          () => setBriefing(owner, false),
        );
      }
    });

    test(`BV-05 [${lang}]: a lead's briefing holds only the projects they lead`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id);
      const led = unique('Lead late task', lang);
      const notLed = unique('Not led late task', lang);
      const tasks: string[] = [];
      try {
        await setBriefing(owner, true);
        tasks.push(await createTask(owner, world().northstar.projectId, led, LATE_DAYS));
        tasks.push(await createTask(owner, world().meridian.projectId, notLed, LATE_DAYS));
        await sweep();

        const briefingUrl = `${ORG_API}/home/briefing`;
        const titles = (body: unknown): string[] =>
          (body as { groups: { lines: { title: string | null }[] }[] }).groups.flatMap((g) =>
            g.lines.map((l) => l.title ?? ''),
          );
        const ownerView = await ok(await owner.context.request.get(briefingUrl));
        expect(ownerView).toHaveProperty('audience', 'company');
        expect(titles(ownerView)).toEqual(expect.arrayContaining([led, notLed]));

        const lead = await signIn(world().northstar.manager.id, {
          member: { org: NORTHSTAR, lang },
        });
        const leadView = await ok(await lead.context.request.get(briefingUrl));
        expect(leadView).toHaveProperty('audience', 'team');
        expect(titles(leadView)).toContain(led);
        expect(titles(leadView)).not.toContain(notLed);

        await lead.page.goto(`/${NORTHSTAR}/home`);
        await expectLanguage(lead.page, lang);
        const card = lead.page.getByRole('region', { name: word(lang, 'HomeBriefing.title') });
        await expect(card.getByText(word(lang, 'HomeBriefing.leadTeam'))).toBeVisible();
        await expect(card.getByRole('link', { name: new RegExp(escape(led), 'u') })).toBeVisible();
        await expect(card.getByText(notLed)).toHaveCount(0);
      } finally {
        await undo(
          () => deleteTasks(owner, tasks),
          () => setBriefing(owner, false),
        );
      }
    });

    test(`BV-06 [${lang}]: a client in the portal sees none of it`, async ({ signIn }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id);
      const { projectId } = world().northstar;
      const clientId = world().atlas.clientOrganizationId;
      const briefing = `${ORG_API}/home/briefing`;
      // The staff screens' reads: each address, and the same address for a record that is not there.
      const staffReads = ['projects', 'client-organizations'].flatMap((parent) =>
        ['summary', 'activity'].map((read) => {
          const id = parent === 'projects' ? projectId : clientId;
          return {
            real: `${ORG_API}/${parent}/${id}/${read}`,
            missing: `${ORG_API}/${parent}/${MISSING_ID}/${read}`,
          };
        }),
      );
      try {
        await setBriefing(owner, true);
        await sweep();
        // The same addresses answer the owner, so the client's refusal is the client's, not a gap.
        for (const url of [briefing, ...staffReads.map((read) => read.real)])
          await ok(await owner.context.request.get(url));

        const client = await signIn(world().atlas.admin.id);
        // The briefing admits every principal and answers a client 404 (B11): no briefing exists.
        expect((await client.context.request.get(briefing)).status()).toBe(404);
        // The staff screens stop a client at their capability ceiling (403), before any record is
        // looked up: the answer for the client's own project is the answer for no project at all.
        for (const { real, missing } of staffReads) {
          expect((await client.context.request.get(real)).status(), real).toBe(403);
          expect((await client.context.request.get(missing)).status(), missing).toBe(403);
        }
        const { page } = client;
        await page.goto(inLang(`/${NORTHSTAR}/portal`, lang));
        await expectLanguage(page, lang);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(
          page.getByRole('heading', { name: word(lang, 'HomeBriefing.title') }),
        ).toHaveCount(0);
        await expect(
          page.getByRole('link', { name: word(lang, 'ActivityTab.tab'), exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole('navigation', { name: word(lang, 'Overview.tabsLabel') }),
        ).toHaveCount(0);
      } finally {
        await undo(() => setBriefing(owner, false));
      }
    });

    test(`BV-07 [${lang}]: Growth shows the new tiles in their honest empty states`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      // The figures are the nightly rollup's; without a run the page says "No growth figures yet".
      const rollup = await runBusinessViewJob(databaseUrl(), 'growth-rollup');
      expect(Number(rollup['rows'])).toBeGreaterThan(0);
      const admin = await signIn(world().platformAdmin.id);
      const { page } = admin;
      await page.goto(inLang('/platform/activity/growth', lang));
      await platformStepUp(page, world().platformAdmin.password);
      await expectLanguage(page, lang);
      for (const tile of [
        'PlatformGrowth.weeklyActive',
        'PlatformGrowth.firstProjectFinished',
        'PlatformGrowth.timeToOutcome',
        'PlatformGrowth.aiTasksRun',
        'PlatformGrowth.aiTasksFinished',
        'PlatformGrowth.aiCreditsUsed',
        'PlatformGrowth.costPerCompany',
        'PlatformGrowth.margin',
      ]) {
        await expect(page.getByText(word(lang, tile), { exact: true }).first()).toBeVisible();
      }
      // No unit costs typed on this stack and billing is the free beta: said, never a 0.
      await expect(page.getByText(word(lang, 'PlatformGrowth.notSet')).first()).toBeVisible();
      await expect(page.getByText(word(lang, 'PlatformGrowth.marginBeta')).first()).toBeVisible();
      await expect(page.getByText(word(lang, 'PlatformGrowth.noData')).first()).toBeVisible();
    });

    test(`BV-08 [${lang}]: the public pages speak of the company, not an agency`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const prefix = lang === 'ar' ? '/ar' : '';
      const agency = lang === 'ar' ? /وكال/u : /\bagenc(y|ies)\b/iu;
      const company = lang === 'ar' ? /شرك/u : /\bcompan(y|ies)\b/iu;
      for (const path of ['/facts', '/compare', '/alternatives/basecamp']) {
        await page.goto(`${prefix}${path}`);
        await expectLanguage(page, lang);
        const main = (await page.locator('main').innerText()).replace(/\s+/gu, ' ');
        expect(main, path).toMatch(company);
        expect(main, path).not.toMatch(agency);
      }
    });
  });
}

test(`BV-09: a cached English page sends a saved-Arabic visitor to the Arabic twin`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // What the CDN keeps: the page as a cookie-less visitor got it, headers and all.
  const anonymous = await browser.newContext();
  const cached = await anonymous.request.get(`${WEB_URL}/pricing`);
  expect(cached.ok()).toBe(true);
  const cachedHtml = await cached.text();
  expect(cachedHtml).toMatch(/<html[^>]* lang="en/u);
  // The body is already decoded here, so the transfer headers of the original answer go.
  const cachedHeaders = Object.fromEntries(
    Object.entries(cached.headers()).filter(
      ([name]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(name),
    ),
  );
  await anonymous.close();

  for (const query of ['', '?lang=en']) {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'tmanage_locale', value: 'ar-EG', url: WEB_URL }]);
    const page = await context.newPage();
    // The document comes from the "CDN", so the origin's proxy never sees the cookie.
    await page.route(
      (url) => url.pathname === '/pricing',
      (route) => route.fulfill({ status: 200, headers: cachedHeaders, body: cachedHtml }),
    );
    await page.goto(`/pricing${query}`);
    if (query === '') {
      await expect(page).toHaveURL(/\/ar\/pricing$/u);
      await expectLanguage(page, 'ar');
    } else {
      // `?lang=en` wins over the saved language, as at the proxy.
      await expect(page).toHaveURL(/\/pricing\?lang=en$/u);
      await expectLanguage(page, 'en');
    }
    await context.close();
  }
});

/** A literal for a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The alert rules as they were read before the journey changed one. */
async function restoreAlertRules(owner: SignedIn, before: unknown): Promise<void> {
  const { rules } = before as {
    rules: { rule: string; enabled: boolean; threshold: number; recipient: string }[];
  };
  await ok(
    await owner.context.request.put(ALERT_RULES, {
      headers: owner.headers,
      data: {
        rules: rules.map(({ rule, enabled, threshold, recipient }) => ({
          rule,
          enabled,
          threshold,
          recipient,
        })),
      },
    }),
  );
}

/** The late tasks a journey made, gone again: the next sweep and briefing no longer count them. */
async function deleteTasks(owner: SignedIn, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await ok(
      await owner.context.request.delete(`${ORG_API}/work-items/${id}`, {
        headers: owner.headers,
      }),
    );
  }
}
