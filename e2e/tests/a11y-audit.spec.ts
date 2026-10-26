import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

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
 * page, and closes the context. The seeded state is only read, with one exception: the bilingual
 * matrix at the end adds its own channel and deliverable (both named `a11y-audit-…`) so a chat
 * channel and the Send-for-approval dialog have something to render; no other journey reads them.
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
    readonly admin: SeededUser;
    readonly approval: { readonly deliverableVersionId: string };
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

/**
 * The bilingual matrix — the main signed-in screens and the client portal, each read in English
 * and in Arabic (right-to-left, through the `?lang=` boot alias), at a 1280px desktop and a 375px
 * phone width in the same page (a resize, not a second load). Here the bar is every violation
 * under the WCAG A/AA tags, whatever its impact; the narrowly-scoped {@link KNOWN_ISSUES} are the
 * only exceptions, each naming the screen, the rule, the node and why it is not fixed here.
 */
const LOCALES = ['en', 'ar'] as const;
type Lang = (typeof LOCALES)[number];
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
] as const;

/** The deliverable version's "Send for approval" button, in each catalogue. */
const SEND_FOR_APPROVAL: Readonly<Record<Lang, string>> = {
  en: 'Send for approval',
  ar: 'إرسال للاعتماد',
};

/**
 * Accepted violations: one screen, one rule, one CSS target substring, and the reason. Never a
 * whole rule. Empty means the matrix is clean.
 */
const KNOWN_ISSUES: ReadonlyArray<{
  readonly screen: string;
  readonly rule: string;
  readonly target: string;
  readonly reason: string;
}> = [];

/** Every WCAG A/AA violation (any impact), minus the known issues for this screen. */
async function auditWcag(page: Page, screen: string): Promise<AxeViolation[]> {
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
  return results.violations
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) =>
          !KNOWN_ISSUES.some(
            (known) =>
              known.screen === screen &&
              known.rule === violation.id &&
              node.target.join(' ').includes(known.target),
          ),
      ),
    }))
    .filter((violation) => violation.nodes.length > 0);
}

/**
 * The wave-5 (Figma F1–F5) triggers, in each catalogue: the buttons that bring up the new dialogs
 * the routes do not show on load.
 */
type FLabel =
  | 'inviteMember'
  | 'moreActions'
  | 'recordDecision'
  | 'changePlan'
  | 'requestExport'
  | 'requestDeletion'
  | 'exportMember';
const F_LABELS: Readonly<Record<Lang, Readonly<Record<FLabel, string>>>> = {
  en: {
    inviteMember: 'Invite member',
    moreActions: 'More actions',
    recordDecision: 'Record as decision',
    changePlan: 'Change plan',
    requestExport: 'Request export',
    requestDeletion: 'Request deletion',
    exportMember: "Export a member's data",
  },
  ar: {
    inviteMember: 'دعوة عضو',
    moreActions: 'إجراءات أخرى',
    recordDecision: 'تسجيل كقرار',
    changePlan: 'غيّر الخطة',
    requestExport: 'طلب التصدير',
    requestDeletion: 'طلب الحذف',
    exportMember: 'تصدير بيانات عضو',
  },
};

/** Click a trigger and wait for the (single) modal dialog it opens. */
async function openDialog(page: Page, trigger: ReturnType<Page['locator']>): Promise<void> {
  await trigger.click();
  await expect(page.getByRole('dialog').last()).toBeVisible();
}

/** The ids the matrix's own fixtures mint once, in `beforeAll`. */
interface MatrixFixtures {
  conversationId: string;
  deliverableId: string;
  /** F3: a second channel holding one message, so "Record as decision" has a source. */
  decisionConversationId: string;
  /** F2: a doc to open in the editor and rename. */
  documentId: string;
}

const MATRIX: ReadonlyArray<{
  readonly name: string;
  readonly as: 'owner' | 'client';
  readonly path: (fixtures: MatrixFixtures) => string;
  /** Bring up a state the route does not show on load (a dialog), after the heading is visible. */
  readonly open?: (page: Page, lang: Lang) => Promise<void>;
}> = [
  { name: 'home', as: 'owner', path: () => `/${ORG}/home` },
  { name: 'inbox', as: 'owner', path: () => `/${ORG}/inbox` },
  { name: 'projects list', as: 'owner', path: () => `/${ORG}/projects/portfolio` },
  {
    name: 'project overview',
    as: 'owner',
    path: () => `/${ORG}/projects/${world().northstar.projectId}`,
  },
  { name: 'work list', as: 'owner', path: () => `/${ORG}/work` },
  { name: 'work item', as: 'owner', path: () => `/${ORG}/work/${world().northstar.workItemId}` },
  { name: 'chat channel', as: 'owner', path: (f) => `/${ORG}/chat/${f.conversationId}` },
  { name: 'docs', as: 'owner', path: () => `/${ORG}/docs` },
  { name: 'meetings', as: 'owner', path: () => `/${ORG}/calendar` },
  {
    name: 'deliverables',
    as: 'owner',
    path: () => `/${ORG}/projects/${world().northstar.projectId}/deliverables`,
  },
  {
    name: 'send for approval dialog',
    as: 'owner',
    path: (f) => `/${ORG}/projects/${world().northstar.projectId}/deliverables/${f.deliverableId}`,
    open: async (page, lang) => {
      await page
        .locator('section[aria-labelledby="tm-deliverable-versions"]')
        .getByRole('button', { name: SEND_FOR_APPROVAL[lang] })
        .click();
      await expect(page.getByRole('dialog', { name: SEND_FOR_APPROVAL[lang] })).toBeVisible();
    },
  },
  { name: 'clients', as: 'owner', path: () => `/${ORG}/clients` },
  {
    name: 'project members',
    as: 'owner',
    path: () => `/${ORG}/projects/${world().northstar.projectId}/members`,
  },
  { name: 'roles', as: 'owner', path: () => `/${ORG}/admin/roles` },
  { name: 'account settings', as: 'owner', path: () => `/${ORG}/settings` },
  { name: 'two-step verification', as: 'owner', path: () => `/${ORG}/settings/two-step` },
  { name: 'security and tokens', as: 'owner', path: () => `/${ORG}/settings/security` },
  { name: 'control center', as: 'owner', path: () => `/${ORG}/admin` },
  { name: 'AI assistant switch', as: 'owner', path: () => `/${ORG}/settings/ai-assistant` },
  { name: 'portal home', as: 'client', path: () => `/${ORG}/portal` },
  {
    name: 'portal approval',
    as: 'client',
    path: () => `/${ORG}/portal/deliverables/${world().atlas.approval.deliverableVersionId}`,
  },
  { name: 'portal new request', as: 'client', path: () => `/${ORG}/portal/requests/new` },
  { name: 'portal files', as: 'client', path: () => `/${ORG}/portal/files` },
  // Wave 5 — the Figma F1–F5 screens.
  {
    name: 'F1 invite member dialog (roles)',
    as: 'owner',
    path: () => `/${ORG}/people`,
    open: (page, lang) =>
      openDialog(page, page.getByRole('button', { name: F_LABELS[lang].inviteMember }).first()),
  },
  {
    name: 'F1 change role dialog (custom roles)',
    as: 'owner',
    path: () => `/${ORG}/people`,
    open: (page) => openDialog(page, page.locator('button.ppl-role-chip').first()),
  },
  {
    name: 'F2 doc rename (editing)',
    as: 'owner',
    path: (f) => `/${ORG}/docs/${f.documentId}/edit`,
    open: async (page) => {
      await page.locator('button.tm-doctitle__trigger').click();
      await expect(page.locator('#tm-doc-title-input')).toBeFocused();
    },
  },
  {
    name: 'F3 record decision dialog',
    as: 'owner',
    path: (f) => `/${ORG}/chat/${f.decisionConversationId}`,
    open: async (page, lang) => {
      const message = page.locator('.tm-chat-message').first();
      await message.hover();
      await message.getByRole('button', { name: F_LABELS[lang].moreActions }).click();
      await openDialog(page, message.getByRole('button', { name: F_LABELS[lang].recordDecision }));
    },
  },
  { name: 'F4 plan and usage', as: 'owner', path: () => `/${ORG}/billing` },
  // F4 change plan preview dialog: not reachable while BILLING_MODE=beta_free (the default) —
  // the approved beta Billing screen has no plan-change button. Restore this entry with paid mode.
  { name: 'F5 privacy', as: 'owner', path: () => `/${ORG}/admin/privacy` },
  {
    name: 'F5 export company dialog',
    as: 'owner',
    path: () => `/${ORG}/admin/privacy`,
    open: (page, lang) =>
      openDialog(
        page,
        page.getByRole('button', { name: F_LABELS[lang].requestExport, exact: true }),
      ),
  },
  {
    name: 'F5 export member dialog',
    as: 'owner',
    path: () => `/${ORG}/admin/privacy`,
    open: (page, lang) =>
      openDialog(
        page,
        page.getByRole('button', { name: F_LABELS[lang].exportMember, exact: true }),
      ),
  },
  {
    name: 'F5 delete company dialog',
    as: 'owner',
    path: () => `/${ORG}/admin/privacy`,
    open: (page, lang) =>
      openDialog(
        page,
        page.getByRole('button', { name: F_LABELS[lang].requestDeletion, exact: true }),
      ),
  },
  { name: 'F5 my data', as: 'owner', path: () => `/${ORG}/settings/my-data` },
];

function withLang(path: string, lang: Lang): string {
  return `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;
}

test.describe('accessibility audit — bilingual matrix, WCAG A/AA, 1280 and 375', () => {
  const fixtures: MatrixFixtures = {
    conversationId: '',
    deliverableId: '',
    decisionConversationId: '',
    documentId: '',
  };

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await signIn(context, world().northstar.owner.id);
      const csrf = (await context.cookies(API_URL)).find(
        (cookie) => cookie.name === 'tmanage_session_csrf',
      )?.value;
      expect(csrf).toBeTruthy();
      const headers = { 'x-csrf-token': csrf as string, origin: WEB_URL };
      const base = `${API_URL}/v1/organizations/${ORG}`;
      const projectId = world().northstar.projectId;

      const channel = await context.request.post(`${base}/conversations`, {
        headers,
        data: { projectId, name: `a11y-audit-${Date.now()}` },
      });
      expect(channel.ok(), await channel.text()).toBe(true);
      fixtures.conversationId = ((await channel.json()) as { id: string }).id;

      const deliverable = await context.request.post(`${base}/deliverables`, {
        headers,
        data: { projectId, title: `a11y-audit-${Date.now()}`, description: null },
      });
      expect(deliverable.ok(), await deliverable.text()).toBe(true);
      fixtures.deliverableId = ((await deliverable.json()) as { id: string }).id;

      const version = await context.request.post(
        `${base}/deliverables/${fixtures.deliverableId}/versions`,
        { headers, data: { fileAssetId: null, note: 'a11y audit version' } },
      );
      expect(version.ok(), await version.text()).toBe(true);

      // F3: a separate channel with one message, so the plain chat-channel case above stays as it was.
      const decisionChannel = await context.request.post(`${base}/conversations`, {
        headers,
        data: { projectId, name: `a11y-audit-decision-${Date.now()}` },
      });
      expect(decisionChannel.ok(), await decisionChannel.text()).toBe(true);
      fixtures.decisionConversationId = ((await decisionChannel.json()) as { id: string }).id;
      const message = await context.request.post(
        `${base}/conversations/${fixtures.decisionConversationId}/messages`,
        { headers, data: { body: 'We go with the blue cover. The client agreed on the call.' } },
      );
      expect(message.ok(), await message.text()).toBe(true);

      // F2: a doc to rename.
      const document = await context.request.post(`${base}/documents`, {
        headers,
        data: { projectId, title: `a11y-audit-doc-${Date.now()}`, body: 'a11y audit doc body' },
      });
      expect(document.ok(), await document.text()).toBe(true);
      fixtures.documentId = ((await document.json()) as { id: string }).id;
    } finally {
      await context.close();
    }
  });

  for (const lang of LOCALES) {
    for (const screen of MATRIX) {
      test(`${screen.name} [${lang}] has no WCAG A/AA axe violations`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: WIDTHS[0] });
        try {
          const userId =
            screen.as === 'client' ? world().atlas.admin.id : world().northstar.owner.id;
          await signIn(context, userId);
          const page = await context.newPage();
          const path = withLang(screen.path(fixtures), lang);
          await page.goto(path, { waitUntil: 'domcontentloaded' });
          await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
          await waitForScreen(page);
          if (lang === 'ar') {
            // Hydration paints the server snapshot (English) first and then switches to the boot
            // locale; audit only once the shell's navigation reads in Arabic.
            await expect(page.getByRole('navigation').first()).toContainText(/[؀-ۿ]/u);
          }
          // The heading paints before the screen's queries answer; an audit taken then reads a
          // skeleton and misses the data rows (this matrix's first green run did exactly that).
          await page.waitForLoadState('networkidle');
          if (screen.open) {
            await screen.open(page, lang);
            await page.waitForLoadState('networkidle');
          }

          const found: string[] = [];
          for (const size of WIDTHS) {
            await page.setViewportSize(size);
            // Let media-query listeners re-render for the new width before axe reads the DOM.
            await page.evaluate(
              () =>
                new Promise<void>((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => done())),
                ),
            );
            // Optional: keep a picture of each screen for the side-by-side check against Figma.
            const shots = process.env['TMANAGE_A11Y_SHOTS'];
            if (shots) {
              await page.screenshot({
                path: resolve(
                  shots,
                  `${screen.name.replace(/[^\w]+/g, '-')}-${lang}-${size.width}.png`,
                ),
                fullPage: true,
              });
            }
            const violations = await auditWcag(page, screen.name);
            found.push(...summarize(violations).map((line) => `@${size.width}: ${line}`));
          }
          expect(found, `${screen.name} [${lang}] (${path})`).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});
