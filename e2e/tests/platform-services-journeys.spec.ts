import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  LANGS,
  expectLanguage,
  inLang,
  platformStepUp,
  seedWorld,
  signedIn,
  word,
} from '../setup/journey-kit.js';
import type { Lang, SignedIn } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — the Platform admin's service cards, in English and in Arabic:
 *
 * - **PS-01 connected services + paused connect** — the operator switches GitHub off for every
 *   organization (a reason is required); a workspace owner's Apps page then shows the calm
 *   "Paused by TManage" notice and GitHub's Connect is disabled and points at it. Switched back
 *   on, the notice is gone. GitHub, because it needs no server keys (`INTEGRATION_ENVIRONMENT`),
 *   so its switch is live on a stack that holds none.
 * - **PS-02 capacity card** — the overview's "Server capacity" card is drawn, with its readings
 *   or its honest "No readings yet" line.
 * - **PS-03 E-mail people** — the operator adds a person who signs tips; the row appears with its
 *   "signs e-mails" switch on, and is switched off again so no later journey mails as them (the
 *   card has no delete).
 */

interface PlatformUser {
  readonly id: string;
  readonly password: string;
}

interface World {
  readonly platformAdmin: PlatformUser;
  readonly northstar: { readonly owner: { readonly id: string } };
}

const NORTHSTAR = 'northstar-studio';
const world = (): World => seedWorld<World>();

async function openPlatform(browser: Browser, path: string, lang: Lang): Promise<SignedIn> {
  const admin = await signedIn(browser, world().platformAdmin.id);
  await admin.page.goto(inLang(path, lang));
  await platformStepUp(admin.page, world().platformAdmin.password);
  await expectLanguage(admin.page, lang);
  return admin;
}

for (const lang of LANGS) {
  test.describe.serial(`platform services [${lang}]`, () => {
    test(`PS-01 [${lang}]: GitHub switched off reads "Paused by TManage" in a workspace, then on again`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const admin = await openPlatform(browser, '/platform/settings', lang);
      const github = word(lang, 'platformServices.github');
      await expect(
        admin.page.getByRole('heading', { name: word(lang, 'platformServices.title') }),
      ).toBeVisible();
      const toggle = admin.page.getByRole('switch', {
        name: word(lang, 'PlatformSettings.integrationSwitch', { name: github }),
      });
      await expect(toggle).toBeChecked();

      const flip = async (titleKey: string, buttonKey: string, reason: string) => {
        await toggle.click();
        const dialog = admin.page.getByRole('dialog');
        await expect(dialog.getByText(word(lang, titleKey, { name: github }))).toBeVisible();
        await dialog.getByRole('textbox').first().fill(reason);
        await dialog.getByRole('button', { name: word(lang, buttonKey), exact: true }).click();
        await expect(dialog).toHaveCount(0);
      };

      const owner = await signedIn(browser, world().northstar.owner.id, {
        member: { org: NORTHSTAR, lang },
      });
      try {
        await flip(
          'PlatformSettings.integrationOffTitle',
          'PlatformSettings.turnOff',
          'TESTE2E pause check',
        );
        await expect(toggle).not.toBeChecked();

        await owner.page.goto(inLang(`/${NORTHSTAR}/automations/apps`, lang));
        await expectLanguage(owner.page, lang);
        await expect(
          owner.page.getByText(word(lang, 'platformServices.pausedTitle')),
        ).toBeVisible();
        await expect(owner.page.getByText(word(lang, 'platformServices.pausedBody'))).toBeVisible();
        const connect = owner.page.locator('[aria-describedby="tm-service-paused-github"]');
        await expect(connect).toBeDisabled();
      } finally {
        if (!(await toggle.isChecked())) {
          await flip(
            'PlatformSettings.integrationOnTitle',
            'PlatformSettings.turnOn',
            'TESTE2E pause check done',
          );
        }
      }
      await expect(toggle).toBeChecked();
      await owner.page.reload();
      await expectLanguage(owner.page, lang);
      await expect(owner.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(owner.page.getByText(word(lang, 'platformServices.pausedTitle'))).toHaveCount(0);
      await expect(owner.page.locator('[aria-describedby="tm-service-paused-github"]')).toHaveCount(
        0,
      );
      await owner.close();
      await admin.context.close();
    });

    test(`PS-02 [${lang}]: the overview draws the Server capacity card`, async ({ browser }) => {
      const admin = await openPlatform(browser, '/platform/settings', lang);
      await admin.page.goto(inLang('/platform', lang));
      await expectLanguage(admin.page, lang);
      await expect(
        admin.page.getByRole('heading', { name: word(lang, 'platformCapacity.title') }),
      ).toBeVisible();
      await expect(admin.page.getByText(word(lang, 'platformCapacity.intro'))).toBeVisible();
      await expect(
        admin.page
          .getByText(word(lang, 'platformCapacity.noReadings'))
          .or(admin.page.getByText(word(lang, 'platformCapacity.ram'), { exact: true }))
          .first(),
      ).toBeVisible();
      await expect(admin.page.getByText(word(lang, 'platformCapacity.errorTitle'))).toHaveCount(0);
      await admin.context.close();
    });

    test(`PS-03 [${lang}]: an operator adds an e-mail person, who appears signing e-mails`, async ({
      browser,
    }) => {
      const admin = await openPlatform(browser, '/platform/settings', lang);
      const { page } = admin;
      await expect(
        page.getByRole('heading', { name: word(lang, 'PlatformMailPeople.title') }),
      ).toBeVisible();
      const name = `Salma Test ${lang} ${Date.now()}`;
      await page.getByRole('button', { name: word(lang, 'PlatformMailPeople.addPerson') }).click();
      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByRole('heading', { name: word(lang, 'PlatformMailPeople.addTitle') }),
      ).toBeVisible();
      // A required field's name ends in the asterisk ("Name*"); anchor it so "Name" never
      // also matches "Arabic name".
      const field = (key: string) =>
        dialog.getByRole('textbox', {
          name: new RegExp(`^${word(lang, key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`),
        });
      await field('PlatformMailPeople.colName').fill(name);
      await field('PlatformMailPeople.colNameAr').fill('سلمى تجربة');
      await field('PlatformMailPeople.fieldRoleEn').fill('Customer success');
      await field('PlatformMailPeople.fieldRoleAr').fill('نجاح العملاء');
      await field('PlatformMailPeople.colAddress').fill(
        `salma.${lang}.${Date.now()}@tmanageapp.com`,
      );
      await dialog
        .getByRole('button', { name: word(lang, 'PlatformMailPeople.addPerson') })
        .click();
      await expect(dialog).toHaveCount(0);

      const signs = page.getByRole('switch', {
        name: word(lang, 'PlatformMailPeople.switchLabel', { name }),
      });
      await expect(signs).toBeChecked();
      // Off again: the card has no delete, and no later journey should mail as this person.
      await signs.click();
      await expect(signs).not.toBeChecked();
      await page.reload();
      await expect(signs).not.toBeChecked();
      await admin.context.close();
    });
  });
}
