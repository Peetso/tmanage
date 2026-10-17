import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * Billing module 19 — the owner's journey across a subscription, a seat and an invoice, through the
 * real stack: the real API routes (`…/billing/subscription`, `…/billing/seats`,
 * `…/billing/invoices`), the real capability guard, the real tenant guard, over cookie + CSRF +
 * origin exactly as the browser carries them.
 *
 * The unit suites prove each controller's logic exhaustively (`subscription.controller.test.ts`,
 * `seats.controller.test.ts`, `invoices.controller.test.ts`); this journey proves the three slices
 * actually wire together end to end for one owner, and that the three refusals that matter reach the
 * wire as the right status — a non-owner is 403, a cross-tenant seat target is a 404 with no write,
 * and a cross-tenant invoice id is a 404 before authorization (the resolve-before-authorize
 * guarantee). **No money moves**: a plan change records `pending_change`, a seat is an assignment
 * fact, and the invoice is a seeded, read-only fixture — there is no provider, card or charge on any
 * path here (Needs-Peter).
 *
 * No browser page is opened: the journey is about the API surface and its guards, so Playwright's
 * request context — the signed-in client with the browser's cookie, CSRF header and origin — is the
 * right client, the shape the upload journey uses for the same reason.
 *
 * `test.describe.serial`, `retries: 0`: the cases share one stack and the seat case mutates then
 * restores the roster, so a serial retry would replay against state that has already moved.
 */

interface SeededUser {
  readonly id: string;
  readonly membershipId: string;
}

interface World {
  readonly northstar: {
    readonly organizationId: string;
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
  };
  readonly brightops: {
    readonly owner: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const NORTHSTAR_SLUG = 'northstar-studio';
const BRIGHTOPS_SLUG = 'brightops-consulting';

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
}

/** The double-submit CSRF token the session set, read from its cookie — required on every write. */
async function csrfToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(API_URL)).find((c) => c.name === 'tmanage_session_csrf');
  expect(cookie?.value).toBeTruthy();
  return cookie?.value as string;
}

/** The write headers the browser sends: the CSRF token and the real origin the API trusts. */
async function writeHeaders(context: BrowserContext): Promise<Record<string, string>> {
  return { 'x-csrf-token': await csrfToken(context), origin: WEB_URL };
}

interface SeededInvoice {
  readonly invoiceId: string;
  readonly number: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: string;
  readonly lineItemCount: number;
}

/**
 * Seed the one invoice the "invoice" leg reads, through the API package's own fixture CLI — the way
 * the seed and the approval fixture cross into this package, because the e2e package holds no
 * database client. The running stack mints no invoice (read-only slice), so there is nothing to list
 * until this runs.
 */
async function seedInvoice(organizationId: string): Promise<SeededInvoice> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const databaseUrl = process.env['TMANAGE_E2E_DATABASE_URL'] as string;
  expect(databaseUrl).toBeTruthy();
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(
      'pnpm',
      [
        '--filter',
        '@tmanage/api',
        'exec',
        'tsx',
        'test/billing-invoice-fixture-cli.ts',
        organizationId,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, TMANAGE_SEED_DATABASE_URL: databaseUrl },
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`invoice fixture exited ${code}\n${err}\n${out}`));
    });
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as SeededInvoice;
}

let seededInvoice: SeededInvoice;

test.beforeAll(async () => {
  seededInvoice = await seedInvoice(world().northstar.organizationId);
});

test.describe.serial('the billing subscription -> seat -> invoice journey', () => {
  test('E2E-BILL-01: an owner reads the free tier, requests a plan change, and it persists as pending', async ({
    browser,
  }) => {
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const base = `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/subscription`;

    // A new organization has a subscription (the free tier, active), not a missing one.
    const initial = await owner.request.get(base);
    expect(initial.ok()).toBe(true);
    expect(await initial.json()).toEqual({
      planId: 'free',
      status: 'active',
      currentPeriodEnd: null,
    });

    // Request a move to a catalog plan — recorded as an intent, no charge.
    const changed = await owner.request.post(`${base}/change`, {
      headers: await writeHeaders(owner),
      data: { planId: 'pro' },
    });
    expect(changed.ok()).toBe(true);
    expect(await changed.json()).toEqual({
      planId: 'pro',
      status: 'pending_change',
      currentPeriodEnd: null,
    });

    // The intent persists on the next read.
    const reread = await owner.request.get(base);
    expect(await reread.json()).toMatchObject({ planId: 'pro', status: 'pending_change' });

    await owner.close();
  });

  test('E2E-BILL-02: an off-catalog plan is a 400 and never overwrites the recorded plan', async ({
    browser,
  }) => {
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const base = `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/subscription`;

    const rejected = await owner.request.post(`${base}/change`, {
      headers: await writeHeaders(owner),
      data: { planId: 'enterprise' },
    });
    expect(rejected.status()).toBe(400);
    // The stable error envelope nests the response code under `error` (`apiErrorBody`): an
    // off-catalog plan is a `validation_failed`, the same code the empty-plan guard returns.
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );

    // The prior intent (pro / pending_change from BILL-01) is untouched — the 400 wrote nothing.
    const after = await owner.request.get(base);
    expect(await after.json()).toMatchObject({ planId: 'pro', status: 'pending_change' });

    await owner.close();
  });

  test('E2E-BILL-03: a non-owner is refused the subscription read with 403', async ({
    browser,
  }) => {
    // Omar is a manager — the capability ceiling withholds `org.manage` from every role but owner.
    const manager = await browser.newContext();
    await signIn(manager, world().northstar.manager.id);
    const denied = await manager.request.get(
      `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/subscription`,
    );
    expect(denied.status()).toBe(403);
    await manager.close();
  });

  test('E2E-BILL-04: an owner assigns a seat, sees it in the roster, cannot double-assign, and reclaims it', async ({
    browser,
  }) => {
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const headers = await writeHeaders(owner);
    const base = `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/seats`;
    const membershipId = world().northstar.designer.membershipId;

    const before = await owner.request.get(base);
    expect(before.ok()).toBe(true);
    const countBefore = (await before.json()).activeCount as number;

    // Assign a seat to a membership — an assignment fact, nothing paid.
    const assigned = await owner.request.post(base, { headers, data: { membershipId } });
    expect(assigned.status()).toBe(201);
    const seat = await assigned.json();
    expect(seat).toMatchObject({ membershipId, releasedAt: null });
    expect(typeof seat.id).toBe('string');

    // It is now in the active roster, and the count has grown by one.
    const roster = await owner.request.get(base);
    const rosterBody = await roster.json();
    expect(rosterBody.activeCount).toBe(countBefore + 1);
    expect((rosterBody.seats as Array<{ id: string }>).some((s) => s.id === seat.id)).toBe(true);

    // A second active seat for the same membership is a 409 conflict.
    const conflict = await owner.request.post(base, { headers, data: { membershipId } });
    expect(conflict.status()).toBe(409);

    // Reclaim the seat — a soft close that stamps `releasedAt` — and the roster is restored.
    const released = await owner.request.delete(`${base}/${seat.id}`, { headers });
    expect(released.ok()).toBe(true);
    expect((await released.json()).releasedAt).not.toBeNull();

    const after = await owner.request.get(base);
    const afterBody = await after.json();
    expect(afterBody.activeCount).toBe(countBefore);
    expect((afterBody.seats as Array<{ id: string }>).some((s) => s.id === seat.id)).toBe(false);

    // Releasing an already-released seat is the same 404 an absent one gives — no second write.
    const doubleRelease = await owner.request.delete(`${base}/${seat.id}`, { headers });
    expect(doubleRelease.status()).toBe(404);

    await owner.close();
  });

  test('E2E-BILL-05: a seat target in another tenant is a 404 with no write', async ({
    browser,
  }) => {
    // The acting owner is Northstar's; the target membership is BrightOps'. It simply does not
    // resolve in the acting tenant, so the answer is the 404 an absent id gives — never a seat
    // created against another studio's membership.
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const foreign = await owner.request.post(
      `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/seats`,
      {
        headers: await writeHeaders(owner),
        data: { membershipId: world().brightops.owner.membershipId },
      },
    );
    expect(foreign.status()).toBe(404);

    // The foreign membership gained no seat in its own tenant either.
    const bright = await browser.newContext();
    await signIn(bright, world().brightops.owner.id);
    const brightRoster = await bright.request.get(
      `${API_URL}/v1/organizations/${BRIGHTOPS_SLUG}/billing/seats`,
    );
    expect((await brightRoster.json()).activeCount).toBe(0);

    await owner.close();
    await bright.close();
  });

  test('E2E-BILL-06: an owner lists the seeded invoice and opens its line-item detail', async ({
    browser,
  }) => {
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const base = `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/invoices`;

    const list = await owner.request.get(base);
    expect(list.ok()).toBe(true);
    const invoices = (await list.json()).invoices as Array<{
      id: string;
      number: string;
      amountCents: number;
      currency: string;
      status: string;
    }>;
    const summary = invoices.find((inv) => inv.id === seededInvoice.invoiceId);
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      number: seededInvoice.number,
      amountCents: seededInvoice.amountCents,
      currency: seededInvoice.currency,
      status: seededInvoice.status,
    });
    // Integer cents, never a float.
    expect(Number.isInteger(summary?.amountCents)).toBe(true);

    const detail = await owner.request.get(`${base}/${seededInvoice.invoiceId}`);
    expect(detail.ok()).toBe(true);
    const detailBody = await detail.json();
    expect(detailBody.lineItems).toHaveLength(seededInvoice.lineItemCount);
    // The header total reconciles to the sum of the line totals.
    const linesTotal = (detailBody.lineItems as Array<{ amountCents: number }>).reduce(
      (sum, line) => sum + line.amountCents,
      0,
    );
    expect(linesTotal).toBe(seededInvoice.amountCents);

    await owner.close();
  });

  test('E2E-BILL-07: an invoice is invisible across tenants and an unknown id is a 404', async ({
    browser,
  }) => {
    // BrightOps' owner, naming Northstar's invoice id against BrightOps' own tenant: the row never
    // resolves, so it is a 404 before any capability check — a probe learns nothing.
    const bright = await browser.newContext();
    await signIn(bright, world().brightops.owner.id);
    const crossTenant = await bright.request.get(
      `${API_URL}/v1/organizations/${BRIGHTOPS_SLUG}/billing/invoices/${seededInvoice.invoiceId}`,
    );
    expect(crossTenant.status()).toBe(404);
    await bright.close();

    // And an unknown id in the owner's own tenant is the same 404.
    const owner = await browser.newContext();
    await signIn(owner, world().northstar.owner.id);
    const unknown = await owner.request.get(
      `${API_URL}/v1/organizations/${NORTHSTAR_SLUG}/billing/invoices/00000000-0000-7000-8000-000000000000`,
    );
    expect(unknown.status()).toBe(404);
    await owner.close();
  });
});
