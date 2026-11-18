import { expect, test } from '@playwright/test';
import { LANGS, expectLanguage, inLang, seedWorld, signedIn, word } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — EMPTY2 / EMPTY3: one teaching empty state per area, in English and
 * in Arabic. Each area's list is empty in the seed for the person who opens it, and the screen
 * says what the list is for and, where they may act, offers the first step.
 *
 * The twin workspace's owner opens the workspace areas: no other journey writes there, so every
 * list below is still empty when this runs, and an owner holds every capability, so every action
 * the screen can offer is drawn. The client portal is opened by Meridian's reviewer, whose
 * project no journey publishes updates to.
 */

interface World {
  readonly twin: { readonly owner: { readonly id: string } };
  readonly meridian: { readonly reviewer: { readonly id: string } };
}

interface Area {
  readonly area: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
  /** The body's placeholders, as the screen fills them. */
  readonly bodyVars?: Readonly<Record<string, string>>;
  /** The first step the screen offers, if it offers one. */
  readonly action?: string;
}

const TWIN = 'northstar-studios';
const NORTHSTAR = 'northstar-studio';
const world = (): World => seedWorld<World>();

const AREAS: readonly Area[] = [
  {
    area: 'admin',
    path: `/${TWIN}/admin/roles`,
    title: 'AdminRolesScreen.emptyTitle',
    body: 'teachEmpty.customRolesBody',
    action: 'teachEmpty.customRolesAction',
  },
  {
    area: 'automations',
    path: `/${TWIN}/automations/schedules`,
    title: 'AutomationSchedulesScreen.emptyTitle',
    body: 'teachEmpty.automationSchedulesBody',
    action: 'teachEmpty.automationSchedulesAction',
  },
  {
    area: 'billing',
    path: `/${TWIN}/billing/cost-centers`,
    title: 'CostCentersView.emptyTitle',
    body: 'teachEmpty.costCentersBody',
    action: 'teachEmpty.costCentersAction',
  },
  {
    area: 'docs',
    path: `/${TWIN}/docs/collections`,
    title: 'DocCollectionsScreen.emptyCollectionsTitle',
    body: 'teachEmpty.docCollectionsBody',
    action: 'teachEmpty.docCollectionsAction',
  },
  {
    area: 'calendar',
    path: `/${TWIN}/calendar/series`,
    title: 'MeetingSeriesScreen.emptyTitle',
    body: 'teachEmpty.meetingSeriesBody',
    action: 'teachEmpty.meetingSeriesAction',
  },
  {
    area: 'inbox',
    path: `/${TWIN}/inbox/rules`,
    title: 'teachEmpty.inboxRulesTitle',
    body: 'teachEmpty.inboxRulesBody',
    action: 'teachEmpty.inboxRulesAction',
  },
  {
    area: 'insights',
    path: `/${TWIN}/insights/targets`,
    title: 'teachEmpty.insightTargetsTitle',
    body: 'teachEmpty.insightTargetsBody',
    action: 'teachEmpty.insightTargetsAction',
  },
  {
    area: 'objectives',
    path: `/${TWIN}/objectives`,
    title: 'OrgObjectivesScreen.emptyTitle',
    body: 'teachEmpty.objectivesBody',
    action: 'teachEmpty.objectivesAction',
  },
  {
    area: 'people',
    path: `/${TWIN}/people/teams`,
    title: 'teachEmpty.teamsTitle',
    body: 'teachEmpty.teamsBody',
  },
  {
    area: 'projects',
    path: `/${TWIN}/projects/tags`,
    title: 'teachEmpty.projectTagsTitle',
    body: 'teachEmpty.projectTagsBody',
    action: 'teachEmpty.projectTagsAction',
  },
  {
    area: 'search',
    path: `/${TWIN}/search/saved`,
    title: 'SavedSearchesScreen.savedEmptyTitle',
    body: 'teachEmpty.savedSearchesBody',
    action: 'teachEmpty.savedSearchesAction',
  },
  {
    area: 'settings',
    path: `/${TWIN}/settings/inbound-mail`,
    title: 'teachEmpty.inboundMailTitle',
    body: 'teachEmpty.inboundMailBody',
  },
  {
    area: 'work',
    path: `/${TWIN}/work/saved-views`,
    title: 'WorkSavedViewsScreen.emptyTitle',
    body: 'teachEmpty.workSavedViewsBody',
    action: 'teachEmpty.workSavedViewsAction',
  },
];

const PORTAL: Area = {
  area: 'portal',
  path: `/${NORTHSTAR}/portal/updates`,
  title: 'teachEmpty.portalUpdatesTitle',
  body: 'teachEmpty.portalUpdatesBody',
  bodyVars: { studio: 'Northstar Studio' },
};

for (const lang of LANGS) {
  test(`TE-01 [${lang}]: every workspace area teaches what its empty list is for`, async ({
    browser,
  }) => {
    // Thirteen screens, each compiled on its first visit by a cold `next dev`.
    test.setTimeout(600_000);
    const owner = await signedIn(browser, world().twin.owner.id, { member: { org: TWIN, lang } });
    const { page } = owner;
    for (const area of AREAS) {
      await test.step(`${area.area}: ${area.path}`, async () => {
        await page.goto(inLang(area.path, lang));
        await expectLanguage(page, lang);
        await expect(page.getByText(word(lang, area.title), { exact: true }).first()).toBeVisible();
        await expect(page.getByText(word(lang, area.body)).first()).toBeVisible();
        if (area.action) {
          const name = word(lang, area.action);
          await expect(
            page.getByRole('button', { name }).or(page.getByRole('link', { name })).first(),
          ).toBeVisible();
        }
      });
    }
    await owner.close();
  });

  test(`TE-02 [${lang}]: the client portal teaches its empty updates`, async ({ browser }) => {
    const client = await signedIn(browser, world().meridian.reviewer.id);
    const { page } = client;
    await page.goto(inLang(PORTAL.path, lang));
    await expectLanguage(page, lang);
    await expect(page.getByText(word(lang, PORTAL.title), { exact: true }).first()).toBeVisible();
    await expect(page.getByText(word(lang, PORTAL.body, PORTAL.bodyVars)).first()).toBeVisible();
    await client.context.close();
  });
}
