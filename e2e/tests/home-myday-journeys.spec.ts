import { expect, test } from '@playwright/test';
import type { APIResponse, Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * Home / My Day v4 — the member's own Saved, Pinned and Recently viewed sections, and the one property
 * they exist to have: they are the *server's* memory of what the member kept, not the tab's, so
 * they are still there after a full reload (and would be there in a fresh browser too). Plus the
 * v4 page itself (spec MYDAY-V4 §4): its parts are named, and Edit widgets (its own page since v4)
 * saves the layout per member.
 *
 * The write surfaces these sections read — `POST .../home/pins`, `PUT .../home/recent-items`,
 * `POST .../home/saved-context` — have no screen control yet (the API lib exports the calls; no
 * component invokes them). So this journey drives those writes the way the browser would — the
 * member's own session cookie, the CSRF header, the real web origin — then opens Home and asserts
 * the three faithful-reader sections render exactly the references the member created, by kind and
 * by link. Each row shows the object's real name: Saved reads it from the API (`title`, gated per
 * source), Pinned and Recent through the object's own authorized GET. A recent whose object does
 * not exist is left out (FIX5 6d), never drawn as a row the member cannot open.
 *
 * Each case uses its own seeded member, because pins and recents are membership-scoped: a fresh
 * member starts empty (the empty-state case depends on it, so it signs in as a member no other
 * journey ever opens anything as), and keeping them apart means one case never has to undo another. The suite runs single-worker against one shared stack; nothing here
 * mutates a work item, so order against the other journeys does not matter.
 */

interface SeededMember {
  readonly id: string;
  readonly membershipId: string;
}

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemTitle: string;
    readonly owner: SeededMember;
    readonly manager: SeededMember;
    readonly designer: SeededMember;
  };
  readonly brightops: {
    readonly workItemId: string;
  };
  /** §11's adversarial twin tenant. Its owner is signed in as by no other journey. */
  readonly twin: {
    readonly owner: SeededMember;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

const SLUG = 'northstar-studio';

/** The dev sign-in route the API registers outside production — a real session, not a mock. */
async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  // A returning person (journey-kit's `asReturningPerson`): v4 restored the My Day coach-mark
  // tour, whose dialog would otherwise open over the page on a first visit.
  await context.addInitScript(() => {
    for (const slug of ['northstar-studio', 'northstar-studios']) {
      window.localStorage.setItem(`tm-coach:${slug}:never`, 'true');
      window.localStorage.setItem(`tm.autotimer.asked.${slug}`, '1');
    }
  });
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, { data: { userId } });
  expect(response.ok()).toBe(true);
  const page = await context.newPage();
  return { context, page };
}

/**
 * A state-changing call to the API as the browser would send it: the session cookie the context
 * already holds, the CSRF token read back from that cookie, and the real web origin — so a refusal
 * could only be the route's own, never the CSRF guard standing in for it.
 */
async function writeAs(
  context: BrowserContext,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<APIResponse> {
  const csrf = (await context.cookies(API_URL)).find((c) => c.name === 'tmanage_session_csrf');
  expect(csrf?.value).toBeTruthy();
  return context.request.fetch(`${API_URL}${path}`, {
    method,
    headers: { 'x-csrf-token': csrf?.value as string, origin: WEB_URL },
    ...(body ? { data: body } : {}),
  });
}

test.describe('Home / My Day — saved, pinned and recent context', () => {
  test('the pins, recents and saved context a member creates render on Home and survive a reload', async ({
    browser,
  }) => {
    const manager = await openAs(browser, world().northstar.manager.id);
    const { workItemId, projectId } = world().northstar;

    // One deliberate pin, two recorded views (a work item with a stable route, and a meeting with
    // none), and one saved-context reference — the three distinct surfaces the three sections read.
    const pin = await writeAs(manager.context, 'POST', `/v1/organizations/${SLUG}/home/pins`, {
      targetKind: 'work',
      targetId: workItemId,
    });
    expect(pin.status()).toBe(201);
    const recentWork = await writeAs(
      manager.context,
      'PUT',
      `/v1/organizations/${SLUG}/home/recent-items`,
      { objectType: 'work', objectId: workItemId },
    );
    expect(recentWork.status()).toBe(200);
    const recentMeeting = await writeAs(
      manager.context,
      'PUT',
      `/v1/organizations/${SLUG}/home/recent-items`,
      { objectType: 'meeting', objectId: '00000000-0000-7000-8000-00000000beef' },
    );
    expect(recentMeeting.status()).toBe(200);
    const saved = await writeAs(
      manager.context,
      'POST',
      `/v1/organizations/${SLUG}/home/saved-context`,
      { entityType: 'work', entityId: workItemId, projectId },
    );
    expect(saved.status()).toBe(201);

    // The assertion made twice: once on first load, once after a full reload. Extracted so the
    // reload is literally "the same checks again" rather than a second, looser copy.
    const title = world().northstar.workItemTitle;
    const assertHome = async (): Promise<void> => {
      // Pinned reads the item's live title through its own authorized GET (restored in v4 by the
      // 2026-11-23 visual check: the old section had read "Pinned work item" on every row).
      const pinned = manager.page.getByRole('region', { name: 'Pinned', exact: true });
      await expect(pinned.getByRole('link', { name: title, exact: true })).toHaveAttribute(
        'href',
        `/${SLUG}/work/${workItemId}`,
      );

      const recents = manager.page.getByRole('region', { name: 'Recently viewed', exact: true });
      await expect(recents.getByRole('link', { name: title, exact: true })).toHaveAttribute(
        'href',
        `/${SLUG}/work/${workItemId}`,
      );
      // FIX5 item 6d: a recent whose object no longer exists (this meeting id names none) is left
      // out, rather than drawn as a row the member cannot open.
      await expect(recents.getByRole('link', { name: 'Meeting', exact: true })).toHaveCount(0);

      // Saved shows the title the API read from the work item, not the kind word.
      const savedRegion = manager.page.getByRole('region', { name: 'Saved', exact: true });
      await expect(savedRegion.getByRole('link', { name: title, exact: true })).toHaveAttribute(
        'href',
        `/${SLUG}/work/${workItemId}`,
      );
      await expect(savedRegion.getByText('Work', { exact: true })).toHaveCount(0);
    };

    await manager.page.goto(`/${SLUG}/home`);
    await assertHome();

    await manager.page.reload();
    await assertHome();

    await manager.context.close();
  });

  test('a member who has kept nothing sees the three empty lines', async ({ browser }) => {
    // The member must be one no journey has ever signed in as. Opening a project or a work item
    // records a "Recently viewed" entry, so any principal another spec drives through the app
    // (the Northstar owner, for one: the a11y-audit matrix opens her overview and a work item, and
    // runs before this file) has kept something by the time this case runs. The twin tenant's
    // owner is signed in as by no other journey, so she has kept nothing, in any suite order.
    const TWIN_SLUG = 'northstar-studios';
    const member = await openAs(browser, world().twin.owner.id);
    await member.page.goto(`/${TWIN_SLUG}/home`);

    await expect(member.page.getByRole('region', { name: 'Pinned', exact: true })).toContainText(
      'Nothing pinned',
    );
    await expect(
      member.page.getByRole('region', { name: 'Recently viewed', exact: true }),
    ).toContainText('Nothing viewed yet');
    await expect(member.page.getByRole('region', { name: 'Saved', exact: true })).toContainText(
      'Nothing saved',
    );

    await member.context.close();
  });

  test('unpinning removes the item from Home after a reload', async ({ browser }) => {
    const member = await openAs(browser, world().northstar.designer.id);
    const { workItemId } = world().northstar;

    const created = await writeAs(member.context, 'POST', `/v1/organizations/${SLUG}/home/pins`, {
      targetKind: 'work',
      targetId: workItemId,
    });
    expect(created.status()).toBe(201);
    const { pins } = (await created.json()) as { pins: readonly { id: string }[] };
    const pinId = pins[0]?.id;
    expect(pinId).toBeTruthy();

    const title = world().northstar.workItemTitle;
    await member.page.goto(`/${SLUG}/home`);
    const pinned = member.page.getByRole('region', { name: 'Pinned', exact: true });
    await expect(pinned.getByRole('link', { name: title, exact: true })).toBeVisible();

    const removed = await writeAs(
      member.context,
      'DELETE',
      `/v1/organizations/${SLUG}/home/pins/${pinId as string}`,
    );
    expect(removed.status()).toBe(200);

    await member.page.reload();
    await expect(pinned).toContainText('Nothing pinned');
    await expect(pinned.getByRole('link', { name: title, exact: true })).toHaveCount(0);

    await member.context.close();
  });

  test('the Home write surface refuses a bad object type and a cross-tenant target', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.manager.id);

    // Reference-only recents are an allowlist: an off-list object type is a 400 with no upsert,
    // not a row the rail would later show as an unknown kind.
    const badType = await writeAs(
      member.context,
      'PUT',
      `/v1/organizations/${SLUG}/home/recent-items`,
      { objectType: 'invoice', objectId: 'anything' },
    );
    expect(badType.status()).toBe(400);
    expect(((await badType.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );

    // A pin resolves its target tenant-scoped before it authorizes: another tenant's work item id,
    // under this tenant's own slug, is told nothing exists (404), the same answer an id that never
    // existed would earn — never a 500, never a leak that it is real elsewhere.
    const crossTenant = await writeAs(
      member.context,
      'POST',
      `/v1/organizations/${SLUG}/home/pins`,
      { targetKind: 'work', targetId: world().brightops.workItemId },
    );
    expect(crossTenant.status()).toBe(404);
    expect(((await crossTenant.json()) as { error: { code: string } }).error.code).toBe(
      'not_found',
    );

    await member.context.close();
  });

  test('the v4 page draws its parts, and Edit widgets keeps a hidden part hidden after a reload', async ({
    browser,
  }) => {
    // The owner: nothing else in this file edits her layout, and the case puts it back at the end.
    const owner = await openAs(browser, world().northstar.owner.id);
    const page = owner.page;
    await page.goto(`/${SLUG}/home`);

    await expect(page.getByRole('heading', { level: 1, name: 'My Day' })).toBeVisible();
    // Spec §4.2 rule 1: "Do this next" is the first part under the header.
    await expect(page.getByRole('group', { name: 'Do this next', exact: true })).toBeVisible();
    for (const name of ['Due & at risk', 'Waiting on you', 'Waiting on others']) {
      await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    }

    const recent = page.getByRole('region', { name: 'Recently viewed', exact: true });
    await expect(recent).toBeVisible();

    // Edit widgets is the last thing in the main column and opens its own page.
    await page.getByRole('link', { name: 'Edit widgets', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${SLUG}/home/widgets$`, 'u'));
    const recentRow = page.getByRole('listitem').filter({ hasText: 'Recent' });
    const show = recentRow.getByRole('checkbox', { name: 'Show', exact: true });
    // "Do this next" is the anchor: it has no row, so it can never be hidden.
    await expect(page.getByRole('listitem').filter({ hasText: /^Next/u })).toHaveCount(0);
    await show.uncheck();
    const save = page.waitForResponse(
      (response) =>
        response.url().includes('/home/widget-prefs') && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    expect((await save).ok()).toBe(true);

    // The layout is the member's own row on the server: My Day, reloaded, keeps it hidden.
    await page.goto(`/${SLUG}/home`);
    await expect(page.getByRole('group', { name: 'Do this next', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recently viewed', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('group', { name: 'Do this next', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recently viewed', exact: true })).toHaveCount(0);

    // Put it back for every later journey.
    await page.goto(`/${SLUG}/home/widgets`);
    await show.check();
    const reset = page.waitForResponse(
      (response) =>
        response.url().includes('/home/widget-prefs') && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    expect((await reset).ok()).toBe(true);
    await page.goto(`/${SLUG}/home`);
    await expect(page.getByRole('region', { name: 'Recently viewed', exact: true })).toBeVisible();

    await owner.context.close();
  });
});
