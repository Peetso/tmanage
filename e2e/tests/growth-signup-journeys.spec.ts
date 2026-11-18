import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { API_URL, ageOrganization } from '../setup/stack.js';
import {
  LANGS,
  databaseUrl,
  expectLanguage,
  inLang,
  platformStepUp,
  seedWorld,
  signedIn,
  word,
} from '../setup/journey-kit.js';
import type { Lang } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — the ways a company arrives, and the one question it is asked later,
 * in English and in Arabic. Every sign-up here is the public form, submitted for real.
 *
 * - **GR-01 pricing → sign-up, beta** — in the free beta the pricing page shows no plan prices and
 *   its Start free goes to a plain sign-up; a `?plan=` typed onto sign-up is still sent, the API
 *   answers no plan, and the new owner lands on My Day.
 * - **GR-02 pricing → sign-up, paid** — with billing switched to Paid (Platform admin, a reason,
 *   put back after), a plan card's call to action carries `?plan=studio`; the form sends it, the
 *   API accepts it, and the new owner lands on billing with that plan to confirm.
 * - **GR-03 referral** — an owner's Invite companies page shows the invite link; a company signs
 *   up through `/sign-up?ref=`; the owner's page then lists it. A manager gets no link.
 * - **GR-04 WTP card** — 14 days after a workspace is created its owner is asked once what they
 *   would pay; the answer is saved and the card does not come back. A manager is not asked, a
 *   younger workspace's owner is not asked, and a client is refused by the API and sees no card.
 * - **GR-05 footer** — the website footer carries "Teams working in Arabic" and "Invite a
 *   company" (MENA, REFERRAL), each to its page in the reader's language.
 */

interface SeededUser {
  readonly id: string;
  readonly email: string;
}

interface PlatformUser {
  readonly id: string;
  readonly password: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly owner: SeededUser;
    readonly manager: SeededUser;
  };
  readonly twin: { readonly organizationId: string; readonly owner: SeededUser };
  readonly brightops: { readonly owner: SeededUser };
  readonly atlas: { readonly admin: SeededUser };
  readonly platformAdmin: PlatformUser;
}

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';
const world = (): World => seedWorld<World>();

interface SignUpSent {
  readonly body: { plan?: string; referral?: string };
  readonly answer: { organizationSlug: string; planId: string | null };
}

/** The sign-up page in the reader's language: an Arabic page links its Arabic twin. */
const signUpPath = (lang: Lang): string => (lang === 'ar' ? '/ar/sign-up' : '/sign-up');

/** The public sign-up form, both steps, as a person fills it. Returns what was sent and answered. */
async function signUp(page: Page, lang: Lang, company: string): Promise<SignUpSent> {
  const stamp = `${lang}${Date.now()}`;
  await page
    .getByLabel(word(lang, 'SignUpFunnel.email'))
    .fill(`founder.${stamp}@harbor-${stamp}.example`);
  await page.getByRole('button', { name: word(lang, 'SignUpFunnel.continue') }).click();
  await expect(
    page.getByRole('heading', { name: word(lang, 'SignUpFunnel.almostTitle') }),
  ).toBeVisible();
  await page.getByLabel(word(lang, 'GettingIn.fullName')).fill('Rami Nasser');
  await page.getByLabel(word(lang, 'SignUpFunnel.workspaceName')).fill(company);
  // The password field by its name: its label also names the Show password toggle.
  await page.locator('input[name="password"]').fill('a-long-test-passphrase-1118');
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/v1/public/sign-up') && r.method() === 'POST'),
    page.getByRole('button', { name: word(lang, 'GettingIn.createWorkspace') }).click(),
  ]);
  const response = await request.response();
  expect(response?.status(), await response?.text()).toBe(201);
  const answer = (await response?.json()) as SignUpSent['answer'];
  await expect(page.getByText(word(lang, 'GettingIn.checkEmailTitle'))).toBeVisible();
  await page.getByRole('button', { name: word(lang, 'GettingIn.openWorkspace') }).click();
  return { body: request.postDataJSON() as SignUpSent['body'], answer };
}

/**
 * Billing mode through the Platform admin page, as E2E-PA10-01 does: the switch needs the
 * password step-up, which only the page's own requests carry.
 */
async function setBillingMode(browser: Browser, mode: 'paid' | 'beta_free'): Promise<void> {
  const admin = await signedIn(browser, world().platformAdmin.id);
  const { page } = admin;
  await page.goto('/platform/settings');
  await platformStepUp(page, world().platformAdmin.password);
  const label = mode === 'paid' ? 'Paid' : 'Beta — free';
  const radio = page.getByRole('radio', { name: new RegExp(`^${label}`, 'u') });
  if ((await radio.getAttribute('aria-checked')) !== 'true') {
    await radio.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason (required)').fill(`TESTE2E pricing carry: ${mode}`);
    await dialog.getByRole('button', { name: `Switch to ${label}` }).click();
    await expect(dialog).toHaveCount(0);
    await expect(radio).toHaveAttribute('aria-checked', 'true');
  }
  await admin.context.close();
  // The mode is cached for 30 s in the API; wait on what the public page reads, not on a clock.
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${API_URL}/v1/public/plan-versions`)).json()) as { visible: boolean })
          .visible,
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(mode === 'paid');
}

for (const lang of LANGS) {
  test.describe.serial(`growth and sign-up [${lang}]`, () => {
    test(`GR-01 [${lang}]: in the beta, pricing hides prices and sign-up lands on My Day`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(lang === 'ar' ? '/ar/pricing' : '/pricing');
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('heading', { name: word(lang, 'PricingPage.betaTitle'), level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(word(lang, 'PricingPage.betaCardTitle'))).toBeVisible();
      for (const key of ['planStarterCta', 'planStudioCta', 'planBusinessCta', 'flatTitle']) {
        await expect(page.getByText(word(lang, `PricingPage.${key}`))).toHaveCount(0);
      }
      const start = page
        .getByRole('main')
        .getByRole('link', { name: word(lang, 'PricingPage.startFree') })
        .first();
      // An Arabic page links the Arabic sign-up, never the English one.
      await expect(start).toHaveAttribute('href', signUpPath(lang));

      await page.goto(`${signUpPath(lang)}?plan=studio`);
      await expectLanguage(page, lang);
      const sent = await signUp(page, lang, `Harbor Beta ${lang}`);
      expect(sent.body.plan).toBe('studio');
      expect(sent.answer.planId).toBeNull();
      await expect(page).toHaveURL(new RegExp(`/${sent.answer.organizationSlug}/home`, 'u'));
      await context.close();
    });

    test(`GR-02 [${lang}]: with billing Paid, a plan's call to action carries ?plan= through sign-up`, async ({
      browser,
    }) => {
      test.setTimeout(300_000);
      await setBillingMode(browser, 'paid');
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(lang === 'ar' ? '/ar/pricing' : '/pricing');
        await expectLanguage(page, lang);
        await expect(
          page.getByRole('heading', { name: word(lang, 'PricingPage.flatTitle'), level: 1 }),
        ).toBeVisible();
        const studio = page.getByRole('link', { name: word(lang, 'PricingPage.planStudioCta') });
        await expect(studio).toHaveAttribute('href', `${signUpPath(lang)}?plan=studio`);
        await studio.click();
        await expect(page).toHaveURL(
          (url) => `${url.pathname}${url.search}` === `${signUpPath(lang)}?plan=studio`,
        );
        await expectLanguage(page, lang);
        const sent = await signUp(page, lang, `Harbor Paid ${lang}`);
        expect(sent.body.plan).toBe('studio');
        expect(sent.answer.planId).toBe('studio');
        await expect(page).toHaveURL(
          new RegExp(`/${sent.answer.organizationSlug}/billing\\?change=studio`, 'u'),
        );
        await context.close();
      } finally {
        await setBillingMode(browser, 'beta_free');
      }
    });

    test(`GR-03 [${lang}]: a company signs up through the owner's invite link and is listed`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const owner = await signedIn(browser, world().northstar.owner.id, {
        member: { org: NORTHSTAR, lang },
      });
      await owner.page.goto(inLang(`/${NORTHSTAR}/admin/invite-agencies`, lang));
      await expectLanguage(owner.page, lang);
      await expect(
        owner.page.getByRole('heading', { name: word(lang, 'InviteAgencies.title') }),
      ).toBeVisible();
      await expect(
        owner.page.getByRole('heading', { name: word(lang, 'InviteAgencies.linkHeading') }),
      ).toBeVisible();
      const link = owner.page.getByText(/\/sign-up\?ref=[a-z0-9.-]+/u).first();
      await expect(link).toBeVisible();
      const code = /\?ref=([a-z0-9.-]+)/u.exec((await link.textContent()) as string)?.[1] as string;
      expect(code).toMatch(/^northstar-studio-[a-z2-9]{6}$/u);

      const company = `Harbor Referred ${lang} ${Date.now()}`;
      const visitor = await browser.newContext();
      const page = await visitor.newPage();
      await page.goto(`${signUpPath(lang)}?ref=${code}`);
      await expectLanguage(page, lang);
      const sent = await signUp(page, lang, company);
      expect(sent.body.referral).toBe(code);
      await visitor.close();

      await owner.page.reload();
      await expect(
        owner.page.getByRole('heading', { name: word(lang, 'InviteAgencies.listHeading') }),
      ).toBeVisible();
      await expect(owner.page.getByText(company)).toBeVisible();
      await owner.close();

      // Not the owner: no link to hand out.
      const manager = await signedIn(browser, world().northstar.manager.id, {
        member: { org: NORTHSTAR, lang },
      });
      await manager.page.goto(inLang(`/${NORTHSTAR}/admin/invite-agencies`, lang));
      await expectLanguage(manager.page, lang);
      await expect(manager.page.locator('body')).toContainText(/\S/u);
      await expect(manager.page.getByText(/\/sign-up\?ref=/u)).toHaveCount(0);
      await manager.close();
    });

    test(`GR-04 [${lang}]: after 14 days the owner is asked once what they would pay; never a client`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      // English asks Northstar's owner (and answers); Arabic the twin's (and skips).
      const { organizationId, owner, slug } =
        lang === 'en'
          ? {
              organizationId: world().northstar.organizationId,
              owner: world().northstar.owner,
              slug: NORTHSTAR,
            }
          : { organizationId: world().twin.organizationId, owner: world().twin.owner, slug: TWIN };
      const question = word(lang, 'PricingSurvey.question');

      // A workspace created today: its owner is not asked yet.
      const young = await signedIn(browser, world().brightops.owner.id, {
        member: { org: 'brightops-consulting', lang },
      });
      await young.page.goto(inLang('/brightops-consulting/home', lang));
      await expectLanguage(young.page, lang);
      await expect(young.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(young.page.getByText(question)).toHaveCount(0);
      await young.close();

      await ageOrganization(databaseUrl(), organizationId, 15);
      const asked = await signedIn(browser, owner.id, { member: { org: slug, lang } });
      const { page } = asked;
      await page.goto(inLang(`/${slug}/home`, lang));
      await expectLanguage(page, lang);
      await expect(page.getByText(word(lang, 'PricingSurvey.eyebrow'))).toBeVisible();
      await expect(page.getByText(question)).toBeVisible();
      const send = page.getByRole('button', { name: word(lang, 'PricingSurvey.send') });
      await expect(send).toBeDisabled();

      if (lang === 'en') {
        await page
          .getByRole('radiogroup', { name: word(lang, 'PricingSurvey.bandsLabel') })
          .getByRole('radio', { name: word(lang, 'PricingSurvey.band_5_9') })
          .check();
        await page
          .getByLabel(word(lang, 'PricingSurvey.noteLabel'))
          .fill('Fair for a team of eight.');
        await send.click();
        await expect(page.getByText(word(lang, 'PricingSurvey.thanks'))).toBeVisible();
      } else {
        await page.getByRole('button', { name: word(lang, 'PricingSurvey.skip') }).click();
        await expect(page.getByText(question)).toHaveCount(0);
      }
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByText(question)).toHaveCount(0);
      const shown = await asked.context.request.get(
        `${API_URL}/v1/organizations/${slug}/pricing-survey`,
      );
      expect(((await shown.json()) as { show: boolean }).show).toBe(false);
      await asked.close();

      if (lang === 'en') {
        // A manager of the same (old enough) workspace is not asked.
        const manager = await signedIn(browser, world().northstar.manager.id);
        const answer = await manager.context.request.get(
          `${API_URL}/v1/organizations/${NORTHSTAR}/pricing-survey`,
        );
        expect(((await answer.json()) as { show: boolean }).show).toBe(false);
        await manager.page.goto(`/${NORTHSTAR}/home`);
        await expect(manager.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(manager.page.getByText(question)).toHaveCount(0);
        await manager.close();
      }

      // A client, never: the API refuses them and their portal has no such card.
      const client = await signedIn(browser, world().atlas.admin.id);
      const refused = await client.context.request.get(
        `${API_URL}/v1/organizations/${NORTHSTAR}/pricing-survey`,
      );
      expect(refused.status()).toBe(403);
      await client.page.goto(inLang(`/${NORTHSTAR}/portal`, lang));
      await expectLanguage(client.page, lang);
      await expect(client.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(client.page.getByText(question)).toHaveCount(0);
      await client.context.close();
    });

    test(`GR-05 [${lang}]: the footer leads to Arabic teams and to inviting a company`, async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const prefix = lang === 'ar' ? '/ar' : '';
      await page.goto(`${prefix}/pricing`);
      await expectLanguage(page, lang);
      const footer = page.locator('nav.tm-web-footer__columns');
      const arabic = footer.getByRole('link', {
        name: word(lang, 'SiteNav.inArabic'),
        exact: true,
      });
      const referral = footer.getByRole('link', {
        name: word(lang, 'SiteNav.referral'),
        exact: true,
      });
      await expect(arabic).toHaveAttribute('href', `${prefix}/arabic`);
      await expect(referral).toHaveAttribute('href', `${prefix}/referral`);
      await referral.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/referral$`, 'u'));
      await expectLanguage(page, lang);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await context.close();
    });
  });
}
