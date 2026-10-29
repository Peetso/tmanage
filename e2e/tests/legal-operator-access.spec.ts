import { expect, test } from '@playwright/test';

/**
 * platform-admin v2 · PA-03 — the operator-access clause (SPEC P1 / §8) on the public legal pages,
 * through a real browser against the real stack.
 *
 * Both the Privacy Policy and the Terms of Service carry the section "Operator access for support,
 * safety and legal reasons" in English, and its Arabic translation on the `/ar` twin pages, which
 * read right to left. The effective date shown is the bumped 2026-10-28.
 */

const EN_HEADING = 'Operator access for support, safety and legal reasons';
const AR_HEADING = 'وصول المشغّل لأغراض الدعم والسلامة والالتزامات القانونية';

test.describe('Legal pages: operator access', () => {
  for (const doc of ['privacy', 'terms'] as const) {
    test(`/legal/${doc} shows the operator-access section in English`, async ({ page }) => {
      const response = await page.goto(`/legal/${doc}`);
      expect(response?.status()).toBe(200);

      const section = page.locator('section#operator-access');
      await expect(section.getByRole('heading', { level: 2 })).toHaveText(EN_HEADING);
      await expect(section).toContainText('requires a fresh identity confirmation');
      await expect(section).toContainText('Organization owners can see these entries');
      // The section index links to it.
      await expect(page.getByRole('link', { name: EN_HEADING })).toHaveAttribute(
        'href',
        '#operator-access',
      );
      await expect(page.locator('time[datetime="2026-10-28"]')).toBeVisible();
    });

    test(`/ar/legal/${doc} shows the section in Arabic, right to left`, async ({ page }) => {
      const response = await page.goto(`/ar/legal/${doc}`);
      expect(response?.status()).toBe(200);

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
      const section = page.locator('section#operator-access');
      const heading = section.getByRole('heading', { level: 2 });
      await expect(heading).toHaveText(AR_HEADING);
      expect(await heading.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');
      await expect(section).toContainText('سجل التدقيق');
      await expect(page.getByText(EN_HEADING)).toHaveCount(0);
    });
  }
});
