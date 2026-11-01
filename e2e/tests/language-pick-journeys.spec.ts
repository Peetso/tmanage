import { expect, test } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * R12 R2 — a member picks a beta language on Preferences › Display and the whole tab follows it
 * (Figma "Languages (R2)" 501:29247). Until the Spanish catalog lands (slice 5) its strings are the
 * English copy, so the journey asserts the document language, not the words. The designer's row is
 * put back to English (US) at the end, because other journeys read the designer's screens.
 */

interface World {
  readonly northstar: { readonly designer: { readonly id: string } };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

test('Preferences → Español sets html[lang="es-ES"], then back to English (US)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const signIn = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId: world().northstar.designer.id },
  });
  expect(signIn.ok()).toBe(true);
  const page = await context.newPage();
  await page.goto('/northstar-studio/settings/display');

  const language = page.getByLabel('Language', { exact: true });
  await language.selectOption('es-ES');
  await page.getByRole('button', { name: /Save/ }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');

  await page.getByLabel('Language', { exact: true }).selectOption('en-US');
  await page.getByRole('button', { name: /Save/ }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await context.close();
});
