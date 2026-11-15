import { expect, test } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * FIX6 item 4 (live check B7) — a staff member's client preview of the portal home froze the tab
 * for more than a minute. The page must finish loading, keep its main thread free, and stop asking
 * the API once it has what it needs, whatever language the browser speaks.
 */
interface World {
  readonly northstar: { readonly owner: { readonly id: string } };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

for (const locale of ['en-US', 'de-DE', 'ar-EG']) {
  test(`the staff client preview of the portal home settles (${locale})`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    const signedIn = await context.request.post(`${API_URL}/v1/dev/sessions`, {
      data: { userId: world().northstar.owner.id },
    });
    expect(signedIn.ok()).toBe(true);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(API_URL)) requests.push(request.url());
    });
    try {
      await page.goto('/northstar-studio/portal', { waitUntil: 'load', timeout: 20_000 });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
      // The overview loads in steps (projects, then the chosen project's updates, milestones,
      // deliverables and people). It must go quiet: three seconds with no API request, within 20 s.
      // A render loop or an unbounded refetch never does.
      let seen = requests.length;
      let quietSince = Date.now();
      const deadline = Date.now() + 20_000;
      while (Date.now() - quietSince < 3_000) {
        expect(
          Date.now(),
          `still asking the API after 20 s: ${requests.length} requests`,
        ).toBeLessThan(deadline);
        await page.waitForTimeout(250);
        if (requests.length !== seen) {
          seen = requests.length;
          quietSince = Date.now();
        }
      }
      expect(requests.length).toBeLessThan(40);
      // The main thread answers: a page in a render loop never runs this.
      const answered = await page.evaluate(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)),
      );
      expect(answered).toBe(true);
      // And it stays quiet.
      const before = requests.length;
      await page.waitForTimeout(5_000);
      const repeated = requests.slice(before);
      expect(repeated, repeated.join(' | ')).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
}
