import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { API_URL, forgeApprovalRecord, seedApprovalFixture } from '../setup/stack.js';
import {
  LANGS,
  databaseUrl,
  expectLanguage,
  inLang,
  seedWorld,
  test,
  word,
} from '../setup/journey-kit.js';
import type { Lang } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — 52-19's evidence bundle and the public /verify page, in English and
 * in Arabic.
 *
 * - **EV-01 evidence download** — an approval decided by its reviewer has a verified record; the
 *   record sheet's "Download evidence" saves `approval-evidence-<id>.zip`, a real ZIP. Its
 *   "Check this record" link opens /verify (/ar/verify) with the record filled in, and the page
 *   says the record is genuine and names the workspace.
 * - **EV-02 public verify** — signed out: the printed ID and fingerprint read *genuine*; another
 *   ID with the same fingerprint reads *not found* and names no workspace; a planted record whose
 *   fingerprint is not its content's (`forge-approval-record-cli.ts`, in the twin workspace, whose
 *   chain is otherwise empty) reads *altered*. The throttle (10 a minute per address) is scaled
 *   ×1000 on the stack, so the page's answer to a 429 is shown by answering one check with the
 *   API's own 429 body; the ceiling itself is the API unit suite's.
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
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
  readonly twin: { readonly organizationId: string; readonly owner: SeededUser };
}

interface DecidedRecord {
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly recordId: string;
  readonly fingerprint: string;
}

const NORTHSTAR = 'northstar-studio';
const world = (): World => seedWorld<World>();
const records: Partial<Record<Lang, DecidedRecord>> = {};

function verifyPath(lang: Lang): string {
  return lang === 'ar' ? '/ar/verify' : '/verify';
}

async function check(page: Page, lang: Lang, recordId: string, fingerprint: string): Promise<void> {
  await page.getByLabel(word(lang, 'VerifyRecord.recordIdLabel')).fill(recordId);
  await page.getByLabel(word(lang, 'VerifyRecord.fingerprintLabel')).fill(fingerprint);
  await page.getByRole('button', { name: word(lang, 'VerifyRecord.submit') }).click();
}

for (const lang of LANGS) {
  test.describe.serial(`approval evidence and verify [${lang}]`, () => {
    test(`EV-01 [${lang}]: a decided approval's evidence downloads and its record checks genuine`, async ({
      signIn,
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

      // Lina decides one review the way her phone does: the waiting row's version, approve.
      const lina = await signIn(northstar.designer.id, {
        member: { org: NORTHSTAR, lang },
      });
      const base = `${API_URL}/v1/organizations/${NORTHSTAR}`;
      const waiting = (await (await lina.context.request.get(`${base}/home/waiting`)).json()) as {
        items: { kind: string; approvalId: string; deliverableId: string; version: number }[];
      };
      const reviews = waiting.items.filter((item) => item.kind === 'approval');
      expect(reviews, 'the fixture opened two reviews on Lina').toHaveLength(2);
      const [entry, other] = reviews as [(typeof reviews)[number], (typeof reviews)[number]];
      const { approvalId, deliverableId, version } = entry;
      const decided = await lina.context.request.post(`${base}/approvals/${approvalId}/decision`, {
        headers: lina.headers,
        data: { decision: 'approve', version },
      });
      expect(decided.ok(), await decided.text()).toBe(true);
      // The fixture's second review is decided too, so nothing is left waiting on Lina for the
      // phone journey, which counts her rows.
      const sentBack = await lina.context.request.post(
        `${base}/approvals/${other.approvalId}/decision`,
        {
          headers: lina.headers,
          data: { decision: 'request_changes', version: other.version, feedback: 'Not this one.' },
        },
      );
      expect(sentBack.ok(), await sentBack.text()).toBe(true);
      const certificate = (await (
        await lina.context.request.get(`${base}/approvals/${approvalId}/record`)
      ).json()) as { intact: boolean; records: { recordId: string; recordHash: string }[] };
      expect(certificate.intact).toBe(true);
      const record = certificate.records.at(-1) as { recordId: string; recordHash: string };
      records[lang] = {
        approvalId,
        deliverableId,
        recordId: record.recordId,
        fingerprint: record.recordHash,
      };

      const { page } = lina;
      await page.goto(
        inLang(
          `/${NORTHSTAR}/projects/${northstar.projectId}/deliverables/${deliverableId}/approvals/${approvalId}/record`,
          lang,
        ),
      );
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('heading', { name: word(lang, 'ApprovalRecord.title'), level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(record.recordId).first()).toBeVisible();

      const evidence = page.getByRole('button', {
        name: word(lang, 'ApprovalRecord.downloadEvidence'),
      });
      const [download] = await Promise.all([page.waitForEvent('download'), evidence.click()]);
      expect(download.suggestedFilename()).toBe(`approval-evidence-${approvalId}.zip`);
      const zip = Buffer.concat(await (await download.createReadStream()).toArray());
      expect(zip.subarray(0, 2).toString('latin1'), 'a ZIP starts with PK').toBe('PK');
      await expect(page.getByText(word(lang, 'ApprovalRecord.downloadEvidenceFailed'))).toHaveCount(
        0,
      );

      // The sheet's own way to the public check: the record arrives filled in and is checked once.
      const link = page.locator(`a[href*="${verifyPath(lang)}#record="]`).first();
      await expect(link).toHaveAttribute('href', new RegExp(record.recordId, 'u'));
      await page.goto((await link.getAttribute('href')) as string);
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('heading', { name: word(lang, 'VerifyRecord.genuineTitle') }),
      ).toBeVisible();
      await expect(
        page.getByText(word(lang, 'VerifyRecord.workspace', { name: 'Northstar Studio' })),
      ).toBeVisible();
      await lina.close();
    });

    test(`EV-02 [${lang}]: /verify reads genuine, not found, altered, and the throttle, signed out`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const decided = records[lang];
      expect(decided, 'EV-01 decided a record first').toBeDefined();
      const { recordId, fingerprint } = decided as DecidedRecord;
      const forged = await forgeApprovalRecord(
        databaseUrl(),
        world().twin.organizationId,
        world().twin.owner.id,
      );

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(verifyPath(lang));
      await expectLanguage(page, lang);
      await expect(
        page.getByRole('heading', { name: word(lang, 'VerifyRecord.title'), level: 1 }),
      ).toBeVisible();
      const verdict = page.locator('#verify-verdict');

      // Both fields are needed: each empty field says so under itself.
      await page.getByRole('button', { name: word(lang, 'VerifyRecord.submit') }).click();
      await expect(page.getByText(word(lang, 'VerifyRecord.required'))).toHaveCount(2);

      // Genuine: pasted as printed — spaced in groups, upper case — still matches.
      const printed = (fingerprint.toUpperCase().match(/.{1,8}/gu) as string[]).join(' ');
      await check(page, lang, recordId.toUpperCase(), printed);
      await expect(verdict).toHaveText(word(lang, 'VerifyRecord.genuineTitle'));
      // The capsule's text also holds its decorative glyph, so it is matched by its own words.
      await expect(
        page.locator('.tm-state-capsule', { hasText: word(lang, 'VerifyRecord.genuineCapsule') }),
      ).toBeVisible();
      await expect(
        page.getByText(word(lang, 'VerifyRecord.workspace', { name: 'Northstar Studio' })),
      ).toBeVisible();

      // Not found: another ID with the same fingerprint — and no workspace named.
      await check(page, lang, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', fingerprint);
      await expect(verdict).toHaveText(word(lang, 'VerifyRecord.notFoundTitle'));
      await expect(page.getByText(word(lang, 'VerifyRecord.notFoundBody'))).toBeVisible();
      await expect(page.getByText('Northstar Studio')).toHaveCount(0);

      // Altered: the record exists, but its fingerprint is not its content's.
      await check(page, lang, forged.recordId, forged.fingerprint);
      await expect(verdict).toHaveText(word(lang, 'VerifyRecord.alteredTitle'));
      await expect(page.getByText(word(lang, 'VerifyRecord.alteredBody'))).toBeVisible();
      await expect(
        page.getByText(word(lang, 'VerifyRecord.workspace', { name: 'Northstar Studios' })),
      ).toBeVisible();

      // The throttle's answer, as the API words it.
      await page.route('**/v1/public/approval-records/verify', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' } }),
        }),
      );
      await check(page, lang, recordId, fingerprint);
      await expect(page.getByText(word(lang, 'VerifyRecord.rateLimited'))).toBeVisible();
      await context.close();
    });
  });
}
