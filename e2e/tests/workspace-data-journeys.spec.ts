import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_URL } from '../setup/stack.js';
import { LANGS, expectLanguage, inLang, seedWorld, test, word } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — a workspace's own data, in English and in Arabic:
 *
 * - **WD-01 export / import link** — an owner exports a project as CSV from its page (a real
 *   download, through the menu), and the portfolio's Import link leads to the import screen. A
 *   member, who holds neither `work.export` nor `org.manage`, sees neither control.
 * - **WD-02 storage card notices** — the billing page's storage card reads the platform ceiling
 *   the stack sets (`STORAGE_ORG_BYTES_LIMIT_BYTES`, 2 × (8 MiB + 16)) and climbs through its
 *   70 / 85 / 95 / 100 % notices as upload reservations fill it. A reservation counts whether or
 *   not bytes follow (E2E-12b), so the journey reserves and then cancels, leaving the twin
 *   workspace as found. The twin, not Northstar: no other journey stores files there.
 * - **WD-03 Tips switch** — a member turns "Send me tips" off, the choice survives a reload, and
 *   turns it back on.
 */

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly owner: { readonly id: string };
    readonly designer: { readonly id: string };
  };
  readonly twin: { readonly projectId: string; readonly owner: { readonly id: string } };
}

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';
/** `e2e/setup/stack.ts`: the platform ceiling the storage card reads. */
const CEILING = 2 * (8 * 1024 * 1024 + 16);

const world = (): World => seedWorld<World>();

/** A catalogue sentence with `{percent}` as a match for any number, in any digits. */
function noticePattern(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(escaped.replace('\\{percent\\}', '[0-9٠-٩]+'), 'u');
}

for (const lang of LANGS) {
  test.describe(`workspace data [${lang}]`, () => {
    test(`WD-01 [${lang}]: an owner exports a project and finds Import; a member sees neither`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().northstar.owner.id, {
        member: { org: NORTHSTAR, lang },
      });
      const { page } = owner;
      await page.goto(inLang(`/${NORTHSTAR}/projects/${world().northstar.projectId}`, lang));
      await expectLanguage(page, lang);

      const trigger = page.getByRole('button', { name: word(lang, 'ProjectExport.trigger') });
      await trigger.click();
      const menu = page.getByRole('menu', { name: word(lang, 'ProjectExport.menuLabel') });
      await expect(menu).toBeVisible();
      const csv = menu
        .getByRole('menuitem')
        .filter({ hasText: word(lang, 'ProjectExport.csvHint') });
      const [download] = await Promise.all([page.waitForEvent('download'), csv.click()]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/u);
      const body = await (await download.createReadStream()).toArray();
      expect(Buffer.concat(body).length).toBeGreaterThan(0);
      await expect(page.getByText(word(lang, 'ProjectExport.failed'))).toHaveCount(0);

      await page.goto(inLang(`/${NORTHSTAR}/projects/portfolio`, lang));
      const importLink = page.getByRole('link', {
        name: word(lang, 'ImportLink.label'),
        exact: true,
      });
      await expect(importLink).toHaveAttribute(
        'href',
        new RegExp(`/${NORTHSTAR}/onboarding/import`),
      );
      await importLink.click();
      await expect(page).toHaveURL(new RegExp(`/${NORTHSTAR}/onboarding/import`));
      await expectLanguage(page, lang);
      await owner.close();

      // A member: no export right, no import right — neither control is drawn.
      const member = await signIn(world().northstar.designer.id, {
        member: { org: NORTHSTAR, lang },
      });
      await member.page.goto(inLang(`/${NORTHSTAR}/projects/${world().northstar.projectId}`, lang));
      await expectLanguage(member.page, lang);
      await expect(member.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(
        member.page.getByRole('button', { name: word(lang, 'ProjectExport.trigger') }),
      ).toHaveCount(0);
      await member.page.goto(inLang(`/${NORTHSTAR}/projects/portfolio`, lang));
      await expect(member.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(
        member.page.getByRole('link', { name: word(lang, 'ImportLink.label'), exact: true }),
      ).toHaveCount(0);
      await member.close();
    });

    test(`WD-02 [${lang}]: the storage card climbs through its 70 / 85 / 95 / 100 % notices`, async ({
      signIn,
    }) => {
      test.setTimeout(240_000);
      const owner = await signIn(world().twin.owner.id, { member: { org: TWIN, lang } });
      const { page, context, headers } = owner;
      const reserved: string[] = [];
      let used = 0;
      const reserveUpTo = async (request: APIRequestContext, percent: number): Promise<void> => {
        const target = Math.ceil((percent * CEILING) / 100);
        const created = await request.post(`${API_URL}/v1/organizations/${TWIN}/upload-sessions`, {
          headers: { ...headers, 'idempotency-key': `wd-02-${lang}-${percent}-${Date.now()}` },
          data: {
            projectId: world().twin.projectId,
            fileName: `storage-${percent}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: target - used,
            purpose: 'deliverable',
          },
        });
        expect(created.status(), await created.text()).toBe(201);
        reserved.push(((await created.json()) as { id: string }).id);
        used = target;
      };

      try {
        await page.goto(inLang(`/${TWIN}/billing`, lang));
        await expectLanguage(page, lang);
        await expect(
          page.getByRole('heading', { name: word(lang, 'PlanUsage.filesHeading') }),
        ).toBeVisible();
        await expect(page.getByText(word(lang, 'planStorage.label')).first()).toBeVisible();
        for (const key of ['70', '85', '95'] as const) {
          await expect(
            page.getByText(noticePattern(word(lang, `planStorage.notice${key}`))),
          ).toHaveCount(0);
        }
        await expect(page.getByText(word(lang, 'planStorage.notice100'))).toHaveCount(0);

        for (const step of [
          { percent: 71, key: 'planStorage.notice70' },
          { percent: 86, key: 'planStorage.notice85' },
          { percent: 96, key: 'planStorage.notice95' },
        ] as const) {
          await reserveUpTo(context.request, step.percent);
          await page.reload();
          await expect(page.getByText(noticePattern(word(lang, step.key)))).toBeVisible();
        }
        await reserveUpTo(context.request, 100);
        await page.reload();
        await expect(page.getByText(word(lang, 'planStorage.notice100'))).toBeVisible();
        await expect(page.getByText(noticePattern(word(lang, 'planStorage.notice95')))).toHaveCount(
          0,
        );
      } finally {
        // Leave the twin as found: every reservation cancelled, the quota free again.
        for (const id of reserved) {
          const cancelled = await context.request.post(
            `${API_URL}/v1/organizations/${TWIN}/upload-sessions/${id}/cancel`,
            { headers },
          );
          expect(cancelled.status(), await cancelled.text()).toBe(200);
        }
        await owner.close();
      }
    });

    test(`WD-03 [${lang}]: "Send me tips" turns off, survives a reload, and turns back on`, async ({
      signIn,
    }) => {
      const member = await signIn(world().northstar.designer.id, {
        member: { org: NORTHSTAR, lang },
      });
      const { page } = member;
      await page.goto(inLang(`/${NORTHSTAR}/inbox/notification-preferences`, lang));
      await expectLanguage(page, lang);
      await expect(page.getByText(word(lang, 'NotificationKindPrefs.kindTipsLabel'))).toBeVisible();
      const tips = page.getByRole('switch', {
        name: word(lang, 'NotificationKindPrefs.kindTipsSwitch'),
      });
      await expect(tips).toBeChecked();

      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/notification-preferences/kinds/tips') &&
          response.request().method() === 'PUT',
      );
      await tips.click();
      expect((await saved).ok()).toBe(true);
      await expect(tips).not.toBeChecked();
      await page.reload();
      await expect(tips).not.toBeChecked();

      await tips.click();
      await expect(tips).toBeChecked();
      await page.reload();
      await expect(tips).toBeChecked();
      await member.close();
    });
  });
}
