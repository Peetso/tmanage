import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * SEC-08 (extended, 56-01) — the browser security policy on every page family, in a real browser
 * against the real stack.
 *
 * For each family (public home, Arabic home, sign-in, a signed-in org page, the client portal, the
 * AI approve page) the HTML response must carry: a CSP whose `script-src` holds a nonce and never
 * `'unsafe-inline'`, the Trusted Types report-only policy, HSTS with `preload`, COOP, and the
 * Permissions-Policy that admits only this origin's microphone. And the page must render without
 * a single CSP violation outside Trusted Types (which is report-only in this train by design).
 *
 * The harness inherits `CSP_MODE`, so the same spec runs both ways:
 *   pnpm test:e2e                     — report-only (the default): header `…-Report-Only`
 *   CSP_MODE=enforce pnpm test:e2e    — the regression wall: the WHOLE suite green under the
 *                                       enforcing policy before live may flip (runbook).
 * `next dev` renders every page per request, so this cannot see the prerendered-page gap the
 * runbook describes; the live soak does.
 */

const ENFORCE = process.env['CSP_MODE']?.trim().toLowerCase() === 'enforce';
const PAGE_POLICY_HEADER = ENFORCE
  ? 'content-security-policy'
  : 'content-security-policy-report-only';
const ORG = 'northstar-studio';

interface World {
  readonly northstar: { readonly owner: { readonly id: string } };
  readonly atlas: { readonly reviewer: { readonly id: string } };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
}

/** Every `securitypolicyviolation` the document raises, recorded from before the first script. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.disposition} ${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

const FAMILIES = [
  { name: 'public home', path: () => '/', as: undefined },
  { name: 'Arabic home', path: () => '/ar', as: undefined },
  { name: 'sign-in', path: () => '/sign-in', as: undefined },
  { name: 'org page', path: () => `/${ORG}/home`, as: () => world().northstar.owner.id },
  { name: 'client portal', path: () => `/${ORG}/portal`, as: () => world().atlas.reviewer.id },
  {
    name: 'AI approve page',
    path: () => `/${ORG}/ai/approve/${randomUUID()}`,
    as: () => world().northstar.owner.id,
  },
] as const;

test.describe('SEC-08 browser security policy', () => {
  for (const family of FAMILIES) {
    test(`${family.name}: nonce CSP, Trusted Types, HSTS preload, COOP, no violations`, async ({
      browser,
    }) => {
      const context = await browser.newContext();
      try {
        if (family.as) await signIn(context, family.as());
        const page = await context.newPage();
        await recordViolations(page);
        const response = await page.goto(family.path(), { waitUntil: 'load' });
        expect(response, family.name).not.toBeNull();
        const header = async (name: string) => (await response!.headerValue(name)) ?? '';

        const policy = await header(PAGE_POLICY_HEADER);
        const scriptSrc = policy.split(';').find((part) => part.trim().startsWith('script-src'));
        expect(scriptSrc, `${PAGE_POLICY_HEADER}: ${policy}`).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
        expect(scriptSrc).toContain("'strict-dynamic'");
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect(policy).toContain("frame-ancestors 'none'");
        expect(await header('content-security-policy-report-only')).toContain(
          "require-trusted-types-for 'script'",
        );
        expect(await header('strict-transport-security')).toMatch(
          /max-age=31536000; includeSubDomains; preload/,
        );
        expect(await header('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
        expect(await header('permissions-policy')).toBe(
          'camera=(), microphone=(self), geolocation=(), interest-cohort=()',
        );

        // Hydration has run its scripts by `load` plus a settled network; any blocked script,
        // style, frame or connection would have raised a violation by now.
        await page.waitForLoadState('networkidle');
        const violations = await page.evaluate(
          () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
        );
        expect(
          violations.filter((line) => !line.includes('require-trusted-types-for')),
          family.name,
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('the API never carries the web page policy', async ({ request }) => {
    const response = await request.get(`${API_URL}/v1/no-such-route`);
    for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
      expect(response.headers()[name] ?? '', name).not.toContain("'nonce-");
    }
  });
});
