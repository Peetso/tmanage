import { expect } from '@playwright/test';
import { API_URL, seedApprovalFixture } from '../setup/stack.js';
import {
  LANGS,
  databaseUrl,
  expectLanguage,
  inLang,
  seedWorld,
  test,
  word,
} from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18), brought to My Day v3.1 (2026-11-22) — PHONE: a team member decides
 * and logs time from My Day on a 390 px phone, without leaving the screen, in English and in Arabic.
 *
 * v3.1 puts the one thing to do now in **Next**: with nothing overdue, the first review waiting on
 * the member. Its Approve / Send back open the bottom sheet; the "On you" rows link to the review.
 * Work rows live in **Due & at risk**, whose row menu holds Log time; the item Next holds is not
 * repeated there, which is why the case logs time while a review still holds Next.
 *
 * - **PM-01** — two deliverable reviews wait on Lina (the stack's approval fixture CLI, with an
 *   internal reviewer this time: the seed has none). Next holds one of them, so her work item is a
 *   Due & at risk row: its menu's "Log time" opens the sheet, a quick-minutes chip and the sheet's
 *   Log time save it, and the work item's time log carries the 30 minutes.
 * - **PM-02** — Next's "Approve" opens the sheet, which names the review and says what goes on
 *   the record; its Approve decides, and Next moves to the second review. Next's "Send back"
 *   opens the sheet with "What should change?", whose Send back stays disabled until there is a
 *   note. Then Next holds her work, and the API agrees: nothing waits on her.
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
    test(`PM-01 [${lang}]: Log time from a Due & at risk row's menu at 390 px`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const { northstar } = world();
      // The reviews PM-02 decides; while one holds Next, the work item is a list row.
      await seedApprovalFixture(databaseUrl(), {
        organizationId: northstar.organizationId,
        projectId: northstar.projectId,
        publisherUserId: northstar.manager.id,
        publisherMembershipId: northstar.manager.membershipId,
        approvedContactEmail: northstar.designer.email,
        approvedContactUserId: northstar.designer.id,
      });

      const lina = await signIn(northstar.designer.id, {
        phone: true,
        member: { org: NORTHSTAR, lang },
      });
      const { page, context } = lina;
      const logs = `${API_URL}/v1/organizations/${NORTHSTAR}/work-items/${northstar.workItemId}/time-logs`;
      const before = ((await (await context.request.get(logs)).json()) as { totalMinutes: number })
        .totalMinutes;

      await page.goto(inLang(`/${NORTHSTAR}/home`, lang));
      await expectLanguage(page, lang);
      const next = page.getByRole('region', { name: word(lang, 'MyDay.w.next'), exact: true });
      await expect(
        next.getByRole('button', { name: startsWith(word(lang, 'MyDay.approve')) }),
      ).toBeVisible();

      const due = page.getByRole('region', { name: word(lang, 'MyDay.w.due'), exact: true });
      await due
        .getByRole('button', {
          name: word(lang, 'MyDay.rowMore', { title: northstar.workItemTitle }),
          exact: true,
        })
        .click();
      await page.getByRole('menuitem', { name: word(lang, 'MyDay.logTime'), exact: true }).click();

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

    test(`PM-02 [${lang}]: Approve and Send back from Next's bottom sheet at 390 px`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const { northstar } = world();
      const lina = await signIn(northstar.designer.id, {
        phone: true,
        member: { org: NORTHSTAR, lang },
      });
      const { page, context } = lina;
      await page.goto(inLang(`/${NORTHSTAR}/home`, lang));
      await expectLanguage(page, lang);

      const next = page.getByRole('region', { name: word(lang, 'MyDay.w.next'), exact: true });
      const approve = next.getByRole('button', { name: startsWith(word(lang, 'MyDay.approve')) });
      const sendBack = next.getByRole('button', {
        name: startsWith(word(lang, 'MyDay.sendBack')),
      });
      await expect(approve).toHaveCount(1);
      // FIXUX-A P1 7: the button names what is being approved ("Project — deliverable · vN") in
      // its hidden ": {title}" suffix, and the sheet names the same item.
      const subject = ((await approve.textContent()) ?? '').split(': ').slice(1).join(': ');
      expect(subject).toMatch(/· v1$/u);

      // Approve: the sheet names the review and says what goes on the record.
      await approve.click();
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
      // Next moves on to the second review.
      await expect(approve).toHaveCount(1);

      // Send back: no note, no sending.
      await sendBack.click();
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
      await expect(approve).toHaveCount(0);
      // With nothing waiting, Next holds her work.
      await expect(
        next.getByRole('link', { name: startsWith(word(lang, 'MyDay.open')) }),
      ).toBeVisible();

      // The server agrees: nothing waits on her any more.
      const waiting = await context.request.get(
        `${API_URL}/v1/organizations/${NORTHSTAR}/home/waiting`,
      );
      expect(waiting.status()).toBe(200);
      const items = ((await waiting.json()) as { items: { kind: string }[] }).items;
      expect(items.filter((item) => item.kind === 'approval')).toHaveLength(0);
      await lina.close();
    });
  });
}
