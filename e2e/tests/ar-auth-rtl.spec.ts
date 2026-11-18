import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * `/ar/sign-in`, `/ar/sign-up` and an Arabic article, through a real browser against the real
 * stack (Figma `428:10174`, `428:10214`, `426:13485`).
 *
 * The visitor arrives on the Arabic URL with an English browser and no saved choice. The path alone
 * decides the language: the document reads right to left in Arabic, the screen's own words are
 * Arabic, links stay on the Arabic twins, `hreflang` names both languages — and a refused sign-in,
 * answered by the real API in English, is shown in Arabic.
 */

const ARABIC = /[؀-ۿ]/;

async function expectRtlArabic(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(ARABIC);
  expect(await heading.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');
}

test.describe('Arabic sign-in and sign-up', () => {
  test('/ar/sign-in renders right to left in Arabic and keeps the email LTR', async ({ page }) => {
    await page.goto('/ar/sign-in');
    await expectRtlArabic(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('تسجيل الدخول');
    await expect(page).toHaveTitle('تسجيل الدخول · TManage');
    const email = page.getByLabel('بريد العمل');
    await expect(email).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
    await expect(page.locator('a[href="/ar/sign-up"]').first()).toBeVisible();
    // The alternates are absolute addresses on the public site (hreflang wants full URLs).
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      'href',
      /^https:\/\/[^/]+\/sign-in$/u,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="ar"]')).toHaveAttribute(
      'href',
      /^https:\/\/[^/]+\/ar\/sign-in$/u,
    );
  });

  test('a refused sign-in on /ar/sign-in is shown in Arabic', async ({ page }) => {
    await page.goto('/ar/sign-in');
    const email = page.getByLabel('بريد العمل');
    await expect(email).toBeEnabled();
    await email.fill('nobody@example.test');
    await page.getByLabel(/^كلمة المرور/).fill('not the password at all');
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await expect(page.getByText('البريد الإلكتروني أو كلمة المرور غير صحيحة.')).toBeVisible();
    await expect(page.getByText('The request carries no valid session')).toHaveCount(0);
  });

  test('/ar/sign-up renders right to left in Arabic, step 1 of the funnel', async ({ page }) => {
    await page.goto('/ar/sign-up');
    await expectRtlArabic(page);
    await expect(page).toHaveTitle(/TManage$/);
    // SIGNUP2: step 1 is the e-mail alone; the name and password come on step 2.
    await expect(page.getByLabel(/^البريد الإلكتروني/)).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'متابعة' })).toBeVisible();
    await expect(page.locator('a[href="/ar/sign-in"]').first()).toBeVisible();
  });
});

test('an article in Arabic links back to the Arabic library', async ({ page }) => {
  await page.goto('/ar/resources/client-approval-playbook');
  await expectRtlArabic(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('دليل موافقات العملاء');
  await expect(page.getByText('شارك نسخة واحدة، لا مجلدًا كاملًا')).toBeVisible();
  await expect(page.locator('main a[href="/ar/resources"]').first()).toBeVisible();
});
