import { expect, test } from '@playwright/test';

/**
 * The Arabic 404 (Figma `429:22543`, the Arabic not-found frame), through a real browser against the
 * real stack.
 *
 * An unknown address under `/ar` used to answer with the English not-found page, left to right.
 * It now answers HTTP 404 with the Arabic page inside the Arabic website chrome: the document reads
 * right to left in Arabic, and both ways back stay on the Arabic site.
 */

test.describe('Arabic not-found page', () => {
  for (const path of ['/ar/no-such-page', '/ar/resources/no-such-article']) {
    test(`${path} answers 404 in Arabic, right to left`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText('لم نجد هذه الصفحة');
      expect(await heading.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');
      await expect(page).toHaveTitle('الصفحة غير موجودة · TManage');
      await expect(page.getByText('Page not found')).toHaveCount(0);

      const main = page.locator('main');
      await expect(main.getByRole('link', { name: 'العودة إلى الصفحة الرئيسية' })).toHaveAttribute(
        'href',
        '/ar',
      );
      await expect(main.getByRole('link', { name: 'تصفّح المصادر' })).toHaveAttribute(
        'href',
        '/ar/resources',
      );
    });
  }

  test('the way back lands on the Arabic resources page', async ({ page }) => {
    await page.goto('/ar/no-such-page');
    await page.locator('main').getByRole('link', { name: 'تصفّح المصادر' }).click();
    await expect(page).toHaveURL(/\/ar\/resources$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
