import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * A11Y-AUDIT — a full accessibility pass over the deployed screens, run in a real browser
 * against the real stack.
 *
 * The unit layer already audits primitives and mounted screens with axe-core in jsdom
 * (`packages/ui/tests/axe.ts`, `apps/web/tests/axe.ts`) and the static half is a lint error
 * (`eslint-plugin-jsx-a11y`). But jsdom neither lays out nor paints, so `color-contrast` is
 * disabled there and reported as *incomplete* — the one WCAG check that needs rendered pixels
 * has never run against the product. This journey closes that gap: the same axe-core engine,
 * but driven in Chromium against the pages as a deployment serves them, with layout and paint,
 * so contrast, focus order, names/roles and landmark structure are all judged on the real DOM.
 *
 * axe-core resolves from the lockfile (a direct dependency of `apps/web` and `packages/ui`),
 * but `@axe-core/playwright` does not, and no network install is permitted. So the engine's own
 * bundled `axe.min.js` is read off disk — resolved through the web app's dependency tree, the
 * version the app itself pins — and injected into each page with `addScriptTag` (the app sets no
 * CSP, see `apps/web/next.config.ts`), then `axe.run` is called in the page.
 *
 * The bar is **serious and critical** violations, restricted to the WCAG 2.0/2.1/2.2 A and AA
 * tags — the target 40-DESIGN-SYSTEM §10 sets. Best-practice-only rules (e.g. `region` when a
 * primitive is mounted bare) are out of scope here and belong to the unit helpers. A failing
 * screen prints every offending rule with its impact and the CSS targets, so the fix is local.
 *
 * Single worker, one shared stack (`globalSetup`): each case opens its own browser context and
 * signs in as the role that can reach the screen (an owner for the admin and billing surfaces,
 * the Atlas client reviewer for the portal, no session at all for the public site), reads the
 * page, and closes the context. Nothing here mutates seeded state, so order does not matter.
 */

/**
 * axe-core's browser bundle, read off disk. It is a direct dependency of `apps/web`, so it
 * resolves through the web app's own `node_modules` — the exact version the application pins,
 * rather than a second copy this package would have to declare and the frozen lockfile reject.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const AXE_SOURCE = readFileSync(
  createRequire(resolve(REPO_ROOT, 'apps/web/package.json')).resolve('axe-core/axe.min.js'),
  'utf8',
);

/** The WCAG 2.0/2.1/2.2 level A and AA tags — the conformance target, nothing best-practice-only. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

const ORG = 'northstar-studio';

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly owner: SeededUser;
    readonly designer: SeededUser;
    readonly workItemId: string;
    readonly projectId: string;
  };
  readonly atlas: {
    readonly reviewer: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The minimal shape of an axe result this audit reads — the engine returns far more. */
interface AxeNode {
  readonly html: string;
  readonly target: readonly string[];
}
interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}
interface AxeResults {
  readonly violations: readonly AxeViolation[];
}

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
}

/**
 * Inject axe-core and run it against the whole document, returning only the serious and critical
 * violations under the WCAG A/AA tags. The script tag is added per call because a cold Next dev
 * server serves a fresh document on each navigation.
 */
async function auditSeriousAndCritical(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const results = (await page.evaluate(async (tags) => {
    const engine = (
      window as unknown as {
        axe: { run: (context: Document, options: object) => Promise<unknown> };
      }
    ).axe;
    return engine.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: [...tags] },
    });
  }, WCAG_TAGS)) as AxeResults;
  return results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

/** One human-readable line per violation, so a red run names the rule, its impact and where it is. */
function summarize(violations: readonly AxeViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.impact}/${violation.id}: ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join('; ')}`,
  );
}

/** The shell is up, and the route's content has rendered, once its page heading is visible. */
async function waitForScreen(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
}

/**
 * The internal application screens, each audited as the role that can reach it. `owner` (Maya)
 * holds `org.manage`, so she reaches the admin and billing surfaces as well as the member ones.
 * Paths that embed seeded ids are built lazily, inside the test, where `world()` is populated.
 */
const INTERNAL_SCREENS: ReadonlyArray<{
  readonly name: string;
  readonly as: 'owner' | 'designer';
  readonly path: () => string;
}> = [
  { name: 'home / my day', as: 'owner', path: () => `/${ORG}/home` },
  { name: 'work list', as: 'owner', path: () => `/${ORG}/work` },
  { name: 'work item', as: 'owner', path: () => `/${ORG}/work/${world().northstar.workItemId}` },
  { name: 'projects portfolio', as: 'owner', path: () => `/${ORG}/projects/portfolio` },
  { name: 'insights', as: 'owner', path: () => `/${ORG}/insights` },
  { name: 'people', as: 'owner', path: () => `/${ORG}/people` },
  { name: 'admin (audit log)', as: 'owner', path: () => `/${ORG}/admin/audit` },
  { name: 'billing', as: 'owner', path: () => `/${ORG}/billing` },
  { name: 'preferences', as: 'owner', path: () => `/${ORG}/preferences` },
  { name: 'preferences — security', as: 'owner', path: () => `/${ORG}/settings/security` },
];

test.describe('accessibility audit — WCAG 2.2 A/AA, serious and critical violations', () => {
  for (const screen of INTERNAL_SCREENS) {
    test(`${screen.name} has no serious or critical axe violations`, async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await signIn(context, world().northstar[screen.as].id);
        const page = await context.newPage();
        const path = screen.path();
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await waitForScreen(page);
        const violations = await auditSeriousAndCritical(page);
        expect(summarize(violations), `${screen.name} (${path})`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('client portal has no serious or critical axe violations', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      // The portal is the client's door; the Atlas reviewer is the seeded client member who sees it.
      await signIn(context, world().atlas.reviewer.id);
      const page = await context.newPage();
      await page.goto(`/${ORG}/portal`, { waitUntil: 'domcontentloaded' });
      await waitForScreen(page);
      const violations = await auditSeriousAndCritical(page);
      expect(summarize(violations), 'client portal').toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const screen of [
    { name: 'public site — home', path: '/' },
    { name: 'public site — contact', path: '/contact' },
  ] as const) {
    test(`${screen.name} has no serious or critical axe violations`, async ({ page }) => {
      await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
      await waitForScreen(page);
      const violations = await auditSeriousAndCritical(page);
      expect(summarize(violations), screen.name).toEqual([]);
    });
  }

  test('the command palette (open) has no serious or critical axe violations', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      await signIn(context, world().northstar.designer.id);
      const page = await context.newPage();
      await page.goto(`/${ORG}/home`, { waitUntil: 'domcontentloaded' });
      await waitForScreen(page);

      // The shell attaches the Ctrl/Cmd-K handler in a post-hydration effect, so the first chord can
      // land before the listener exists and be lost. Press only while the dialog is still absent — a
      // condition-driven retry, never a blind re-press that would toggle an open palette shut.
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      await expect(async () => {
        if (!(await dialog.isVisible())) {
          await page.keyboard.press('Control+KeyK');
        }
        await expect(dialog).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expect(dialog.getByRole('combobox')).toBeFocused();

      const violations = await auditSeriousAndCritical(page);
      expect(summarize(violations), 'command palette (open)').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
