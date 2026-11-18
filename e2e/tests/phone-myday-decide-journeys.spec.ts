import { expect, test } from '@playwright/test';
import { API_URL, seedApprovalFixture } from '../setup/stack.js';
import {
  LANGS,
  databaseUrl,
  expectLanguage,
  inLang,
  seedWorld,
  signedIn,
  word,
} from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — PHONE: a team member decides and logs time from My Day on a 390 px
 * phone, without leaving the screen, in English and in Arabic.
 *
 * - **PM-01** — two deliverable reviews wait on Lina (the stack's approval fixture CLI, with an
 *   internal reviewer this time: the seed has none). "Approve" opens the bottom sheet, which says
 *   what goes on the record; its Approve decides. "Send back" opens the sheet with "What should
 *   change?", whose Send back stays disabled until there is a note. Both rows leave "Waiting on
 *   you", and the API agrees: nothing waits on her.
 * - **PM-02** — "Log time" on her work card opens the sheet; a quick-minutes chip and the sheet's
 *   Log time save it, and the work item's time log carries the 30 minutes.
 */

interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly membershipId: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemTitle: string;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
}

const NORTHSTAR = 'northstar-studio';
const world = (): World => seedWorld<World>();

function startsWith(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
}

for (const lang of LANGS) {
  test.describe.serial(`phone My Day decisions [${lang}]`, () => {
    test(`PM-01 [${lang}]: Approve and Send back from the bottom sheet at 390 px`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const { northstar } = world();
      await seedApprovalFixture(databaseUrl(), {
        organizationId: northstar.organizationId,
        projectId: northstar.projectId,
        publisherUserId: northstar.manager.id,
        publisherMembershipId: northstar.manager.membershipId,
        approvedContactEmail: northstar.designer.email,
        approvedContactUserId: northstar.designer.id,
      });

      const lina = await signedIn(browser, northstar.designer.id, {
        phone: true,
        member: { org: NORTHSTAR, lang },
      });
      const { page, context } = lina;
      await page.goto(inLang(`/${NORTHSTAR}/home`, lang));
      await expectLanguage(page, lang);

      const rowApprove = page.getByRole('button', {
        name: startsWith(word(lang, 'PhoneHome.approve')),
      });
      const rowSendBack = page.getByRole('button', {
        name: startsWith(word(lang, 'PhoneHome.sendBack')),
      });
      await expect(rowApprove).toHaveCount(2);
      await expect(rowApprove.first()).toBeVisible();
      // FIXUX-A P1 7: a row names what is being approved ("Project — deliverable · vN"), in the
      // button's hidden ": {title}" suffix, and the sheet names the same item.
      const subject = ((await rowApprove.first().textContent()) ?? '')
        .split(': ')
        .slice(1)
        .join(': ');
      expect(subject).toMatch(/· v1$/u);

      // Approve: the sheet names the review and says what goes on the record.
      await rowApprove.first().click();
      const sheet = page.getByRole('dialog');
      await expect(
        sheet.getByText(word(lang, 'PhoneHome.approveTitle', { subject })),
      ).toBeVisible();
      await expect(sheet.getByText(word(lang, 'PhoneHome.approveBody'))).toBeVisible();
      await sheet
        .getByRole('button', { name: word(lang, 'PhoneHome.approve'), exact: true })
        .click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText(word(lang, 'PhoneHome.approvedNotice'))).toBeVisible();
      await expect(rowApprove).toHaveCount(1);

      // Send back: no note, no sending.
      await rowSendBack.first().click();
      const send = sheet.getByRole('button', {
        name: word(lang, 'PhoneHome.sendBack'),
        exact: true,
      });
      await expect(send).toBeDisabled();
      await sheet
        .getByLabel(word(lang, 'PhoneHome.whatShouldChange'))
        .fill('Make the hero image larger.');
      await expect(send).toBeEnabled();
      await send.click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText(word(lang, 'PhoneHome.sentBackNotice'))).toBeVisible();
      await expect(rowApprove).toHaveCount(0);

      // The server agrees: nothing waits on her any more.
      const waiting = await context.request.get(
        `${API_URL}/v1/organizations/${NORTHSTAR}/home/waiting`,
      );
      expect(waiting.status()).toBe(200);
      const items = ((await waiting.json()) as { items: { kind: string }[] }).items;
      expect(items.filter((item) => item.kind === 'approval')).toHaveLength(0);
      await lina.close();
    });

    test(`PM-02 [${lang}]: Log time from the work card's bottom sheet at 390 px`, async ({
      browser,
    }) => {
      const { northstar } = world();
      const lina = await signedIn(browser, northstar.designer.id, {
        phone: true,
        member: { org: NORTHSTAR, lang },
      });
      const { page, context } = lina;
      const logs = `${API_URL}/v1/organizations/${NORTHSTAR}/work-items/${northstar.workItemId}/time-logs`;
      const before = ((await (await context.request.get(logs)).json()) as { totalMinutes: number })
        .totalMinutes;

      await page.goto(inLang(`/${NORTHSTAR}/home`, lang));
      await expectLanguage(page, lang);
      await page
        .getByRole('button', {
          name: new RegExp(`${word(lang, 'PhoneHome.logTime')}.*${northstar.workItemTitle}`, 'u'),
        })
        .click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText(word(lang, 'PhoneHome.minutesHint'))).toBeVisible();
      await sheet.getByRole('button', { name: '30', exact: true }).click();
      await expect(
        sheet.getByRole('spinbutton', { name: word(lang, 'PhoneHome.minutesLabel') }),
      ).toHaveValue('30');
      await sheet.getByLabel(word(lang, 'PhoneHome.noteLabel')).fill('Booking flow review');
      await sheet
        .getByRole('button', { name: word(lang, 'PhoneHome.logTime'), exact: true })
        .click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText(word(lang, 'PhoneHome.timeLoggedNotice'))).toBeVisible();

      const after = (await (await context.request.get(logs)).json()) as { totalMinutes: number };
      expect(after.totalMinutes).toBe(before + 30);
      await lina.close();
    });
  });
}
