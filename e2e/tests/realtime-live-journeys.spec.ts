import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../setup/stack.js';

/**
 * 51-06 — realtime through Hostinger, watched from two real browsers.
 *
 * - **RT-LIVE-01** two people in one channel: a message sent in A appears in B within a second,
 *   and B's network shows the socket frame arriving before any refetch of the transcript — the
 *   message came by push, not by polling.
 * - **RT-LIVE-02** both sit idle (5 minutes by default — LiteSpeed's idle timeout is the thing
 *   under test), then a message still arrives in B within 5 s: either the socket survived on the
 *   server's pings, or the hook reconnected and caught up.
 * - **RT-LIVE-03** B opens one page more than `REALTIME_MAX_SOCKETS_PER_MEMBER` allows; the
 *   extra page's socket is closed 4429 `retry-after=<s>` and its hook dials again after the hint.
 *
 * ## Two modes
 *
 * **The e2e stack** (`pnpm test:e2e`): signs the seeded owner and designer in through the dev
 * route and makes a fresh channel. The journeys need the worker's socket attached (`server.mjs`
 * with `WORKER_INPROCESS=1`); a stack whose ticket mint answers `socketUrl: null` runs no socket,
 * and the journeys skip with that reason rather than pass on a polling fallback. Shorten the idle
 * with `E2E_RT_IDLE_MS` and set the stack's `REALTIME_MAX_SOCKETS_PER_MEMBER=2` /
 * `REALTIME_PING_INTERVAL_MS` to match (`E2E_RT_MEMBER_CAP`, default 2 here).
 *
 * **Live** (the R1 gate evidence, `docs/runbooks/realtime-live-proof.md`):
 *
 * ```
 * E2E_BASE_URL=https://tmanage.peetrix.com \
 * E2E_RT_STORAGE_A=./.auth/rt-a.json E2E_RT_STORAGE_B=./.auth/rt-b.json \
 * E2E_RT_CHANNEL_PATH=/<org-slug>/chat/<channel-id> \
 * pnpm --filter @tmanage/e2e exec playwright test -c playwright.live.config.ts
 * ```
 *
 * The two storage states are two test accounts signed in by hand (`playwright codegen
 * --save-storage`), both members of the channel. `E2E_API_URL` defaults to `E2E_BASE_URL` (the
 * single Hostinger app serves `/v1` on the same origin); `E2E_RT_MEMBER_CAP` defaults to 5 there.
 */

const LIVE = Boolean(process.env['E2E_BASE_URL']);
const API = LIVE
  ? (process.env['E2E_API_URL'] ?? (process.env['E2E_BASE_URL'] as string))
  : API_URL;
const IDLE_MS = Number(process.env['E2E_RT_IDLE_MS'] ?? 5 * 60_000);
const MEMBER_CAP = Number(process.env['E2E_RT_MEMBER_CAP'] ?? (LIVE ? 5 : 2));
const ORG_SLUG = 'northstar-studio';

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly owner: { readonly id: string };
    readonly designer: { readonly id: string };
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/**
 * Wrap the browser's WebSocket before the app loads, so a journey can read close codes and count
 * dials — Playwright's own websocket events carry neither the code nor the reason.
 */
const RECORD_SOCKETS = `(() => {
  const Native = window.WebSocket;
  window.__rt = { dials: 0, opens: 0, closes: [] };
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      window.__rt.dials += 1;
      this.addEventListener('open', () => { window.__rt.opens += 1; });
      this.addEventListener('close', (e) => { window.__rt.closes.push({ code: e.code, reason: e.reason }); });
    }
  };
})();`;

interface SocketRecord {
  readonly dials: number;
  readonly opens: number;
  readonly closes: readonly { readonly code: number; readonly reason: string }[];
}

function socketRecord(page: Page): Promise<SocketRecord> {
  return page.evaluate(() => (window as unknown as { __rt: SocketRecord }).__rt);
}

async function devSignIn(context: BrowserContext, userId: string): Promise<string> {
  const response = await context.request.post(`${API}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

interface Party {
  readonly context: BrowserContext;
  readonly page: Page;
}

interface Room {
  readonly a: Party;
  readonly b: Party;
  readonly path: string;
  /** Another context for B — same person — for RT-LIVE-03's extra pages. */
  newB(): Promise<BrowserContext>;
}

async function newParty(context: BrowserContext, path: string): Promise<Party> {
  await context.addInitScript(RECORD_SOCKETS);
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.getByLabel('Message the channel')).toBeVisible();
  // The hook is live once its socket opened.
  await expect.poll(async () => (await socketRecord(page)).opens).toBeGreaterThan(0);
  return { context, page };
}

async function openRoom(browser: Browser): Promise<Room | string> {
  if (LIVE) {
    const storageA = process.env['E2E_RT_STORAGE_A'];
    const storageB = process.env['E2E_RT_STORAGE_B'];
    const path = process.env['E2E_RT_CHANNEL_PATH'];
    if (!storageA || !storageB || !path) {
      return 'live mode needs E2E_RT_STORAGE_A, E2E_RT_STORAGE_B and E2E_RT_CHANNEL_PATH';
    }
    const a = await newParty(await browser.newContext({ storageState: storageA }), path);
    const b = await newParty(await browser.newContext({ storageState: storageB }), path);
    return { a, b, path, newB: () => browser.newContext({ storageState: storageB }) };
  }

  const { northstar } = world();
  const ownerContext = await browser.newContext();
  const csrf = await devSignIn(ownerContext, northstar.owner.id);
  const headers = { 'X-CSRF-Token': csrf };
  const base = `${API}/v1/organizations/${ORG_SLUG}`;

  // No socket on this stack: say so, do not pass on the refetch fallback.
  const mint = await ownerContext.request.post(`${base}/realtime/tickets`, { headers });
  expect(mint.ok()).toBe(true);
  if (((await mint.json()) as { socketUrl: string | null }).socketUrl === null) {
    await ownerContext.close();
    return 'this stack runs no realtime socket (ticket mint socketUrl null; needs server.mjs with WORKER_INPROCESS=1)';
  }

  const created = await ownerContext.request.post(`${base}/conversations`, {
    headers,
    data: { projectId: northstar.projectId, name: `rt-live-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  // CQ-12 may already have enrolled her; a conflict is fine.
  await ownerContext.request.post(`${base}/conversations/${id}/members`, {
    headers,
    data: { userId: northstar.designer.id },
  });
  const path = `/${ORG_SLUG}/chat/${id}`;
  const newB = async (): Promise<BrowserContext> => {
    const context = await browser.newContext();
    await devSignIn(context, northstar.designer.id);
    return context;
  };
  const a = await newParty(ownerContext, path);
  const b = await newParty(await newB(), path);
  return { a, b, path, newB };
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message the channel').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe.serial('RT-LIVE — realtime through the proxy', () => {
  test('RT-LIVE-01: a message in A appears in B within a second, by push', async ({ browser }) => {
    const room = await openRoom(browser);
    test.skip(typeof room === 'string', typeof room === 'string' ? room : '');
    const { a, b } = room as Room;

    // B's network, from the send on: when the event frame arrived, and every transcript read.
    let sentAt = 0;
    let frameAt = 0;
    const readsAt: number[] = [];
    b.page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (sentAt > 0 && frameAt === 0 && String(payload).includes('"type":"event"')) {
          frameAt = Date.now();
        }
      });
    });
    b.page.on('request', (request) => {
      if (sentAt > 0 && request.method() === 'GET' && /\/messages(\?|$)/.test(request.url())) {
        readsAt.push(Date.now());
      }
    });

    const text = `RT-LIVE-01 ${Date.now()}`;
    sentAt = Date.now();
    await send(a.page, text);
    await expect(b.page.getByText(text)).toBeVisible({ timeout: 1_000 });

    expect(frameAt, 'B received a socket event frame').toBeGreaterThan(0);
    expect(
      readsAt.filter((at) => at < frameAt),
      'no transcript refetch before the frame (no polling)',
    ).toEqual([]);
    await a.context.close();
    await b.context.close();
  });

  test('RT-LIVE-02: after an idle, a message still arrives (or B reconnects and catches up)', async ({
    browser,
  }) => {
    test.setTimeout(IDLE_MS + 120_000);
    const room = await openRoom(browser);
    test.skip(typeof room === 'string', typeof room === 'string' ? room : '');
    const { a, b } = room as Room;

    await b.page.waitForTimeout(IDLE_MS);
    const before = await socketRecord(b.page);

    const text = `RT-LIVE-02 ${Date.now()}`;
    await send(a.page, text);
    await expect(b.page.getByText(text)).toBeVisible({ timeout: 5_000 });

    const after = await socketRecord(b.page);
    // The record for the run log: did the socket survive the idle, or was it re-dialled?
    test.info().annotations.push({
      type: 'rt-live-02',
      description: `idle ${IDLE_MS} ms; dials ${before.dials}→${after.dials}; closes ${JSON.stringify(after.closes)}`,
    });
    await a.context.close();
    await b.context.close();
  });

  test('RT-LIVE-03: one socket past the member cap closes 4429 and the hook retries', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const room = await openRoom(browser);
    test.skip(typeof room === 'string', typeof room === 'string' ? room : '');
    const { a, b, path, newB } = room as Room;

    // B already holds one socket; fill the cap with more pages, each waiting for its socket.
    const extra: BrowserContext[] = [];
    for (let i = 1; i < MEMBER_CAP; i += 1) {
      const context = await newB();
      extra.push(context);
      await newParty(context, path);
    }

    // One more: its socket is accepted at the upgrade, then closed 4429.
    const overflowContext = await newB();
    extra.push(overflowContext);
    await overflowContext.addInitScript(RECORD_SOCKETS);
    const overflow = await overflowContext.newPage();
    await overflow.goto(path);
    await expect
      .poll(async () => (await socketRecord(overflow)).closes.map((c) => c.code), {
        timeout: 15_000,
      })
      .toContain(4429);
    const capped = (await socketRecord(overflow)).closes.find((c) => c.code === 4429);
    expect(capped?.reason).toMatch(/^retry-after=\d+$/);

    // Not terminal: after the hint the hook dials again.
    const hintMs = Number(/\d+/.exec(capped?.reason ?? '')?.[0] ?? '0') * 1_000;
    await expect
      .poll(async () => (await socketRecord(overflow)).dials, { timeout: hintMs + 15_000 })
      .toBeGreaterThan(1);

    for (const context of [...extra, a.context, b.context]) await context.close();
  });
});
