import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../setup/stack.js';

/**
 * The delivery loop, through a real browser against the real stack.
 *
 * - **E2E-03, "Work → blocker → resolution → internal review: health/inbox update
 *   correctly"** — the maker of a work item hits a wall, says what the wall is and what would
 *   move it, gets unblocked, and hands the result to review. The exit assertion is not about
 *   the item's own page: it is that the places a *different* person looks say the same thing
 *   the item's own page says, at each step.
 * - **AUTH-02, "Direct object ID from BrightOps used by Northstar: deny before lookup or
 *   through organization-scoped lookup; zero side effects"** — a Northstar member pastes a
 *   BrightOps work-item id under Northstar's own valid slug, then the adversarial twin's id,
 *   whose work item carries a byte-identical title to Northstar's own. Both earn the not-found
 *   the id would earn if it did not exist, on a read **and on a write**. "Zero side effects"
 *   is then checked from the far side: BrightOps' owner opens their item and finds it at the
 *   version it was seeded with.
 *
 * AUTH-01 already covers the same attack one level up — a stranger *slug* — from the
 * onboarding journeys. This one keeps the slug honest and swaps the object id, which is the
 * case a route guard alone cannot answer.
 *
 * ## Two narrowings, said out loud
 *
 * **"Health" here is arithmetic over `work_items.state`, not WORK-003's health signal.**
 * `work-items.controller.ts` exposes `GET :id/blockers` and `GET :id/health`, and
 * `docs/implementation-status.md` records that neither has a web surface yet. The project
 * screen's "How it is going" panel counts states client-side, so this journey proves the
 * screens agree with each other and with the state machine — it does not exercise
 * `findActiveBlocker` or `resolveActiveBlocker`. When WORK-003 gains a screen, this journey
 * should assert against it instead of alongside it.
 *
 * **"Inbox" here is the work list filtered by state.** `navigation.ts` reserves an `inbox`
 * destination and no route implements it; the state-filtered work list is the surface a person
 * actually opens to find what is waiting, so it is what the catalog's word is read as.
 *
 * **E2E-04 is deliberately absent.** "Upload → internal review → real-policy preview →
 * publish" needs a deliverable and a file, and FILE-001 has no screens and no endpoints yet;
 * the only half of it that exists today is the audience widening this repository already
 * tests. Writing a journey that walked the half would put the catalog id next to something
 * that is not the journey, which is worse than the gap.
 *
 * ## What this file leaves behind
 *
 * E2E-03 moves the seeded Northstar work item from `in_progress` through `internal_review` to
 * `done` and does not put it back — reversing a journey is not a journey. The suite therefore needs a fresh
 * stack per run, which is what `globalSetup` already gives it, and `retries` must stay at 0: a
 * serial retry would replay E2E-03a against an item that is no longer `in_progress`.
 */

interface SeededUser {
  readonly id: string;
}

interface World {
  readonly northstar: {
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemTitle: string;
    readonly designer: SeededUser;
    readonly manager: SeededUser;
  };
  readonly twin: {
    readonly workItemId: string;
    readonly workItemTitle: string;
  };
  readonly brightops: {
    readonly workItemId: string;
    readonly workItemTitle: string;
    readonly owner: SeededUser;
  };
}

function world(): World {
  return JSON.parse(process.env['TMANAGE_E2E_WORLD'] as string) as World;
}

/** The dev sign-in route the API registers outside production — a session, not a mock. */
async function signIn(context: BrowserContext, userId: string): Promise<void> {
  const response = await context.request.post(`${API_URL}/v1/dev/sessions`, {
    data: { userId },
  });
  expect(response.ok()).toBe(true);
}

async function openAs(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await signIn(context, userId);
  const page = await context.newPage();
  return { context, page };
}

/** Every work-item URL in this file, spelled once. */
function workUrl(organizationSlug: string, workItemId: string): string {
  return `/${organizationSlug}/work/${workItemId}`;
}

const BLOCKER_REASON = 'The booking provider has not sent the sandbox credentials';
const BLOCKER_ASK = 'Ahmed at Atlas to forward the sandbox key from the provider';
const BLOCKER_RESOLUTION = 'Atlas forwarded the sandbox key and it authenticates';

test.describe.serial('the work-delivery journeys', () => {
  test('E2E-03a: the work is blocked, and the project and the list both say so', async ({
    browser,
  }) => {
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));

    // Where it starts. Scoped to the header panel and asserted by containment rather than
    // exact text: `StateCapsule` prefixes an `aria-hidden` glyph, so the capsule's whole text
    // is never the bare word. The region name is `exact` because the sibling panel is called
    // "Move this item", and `getByRole`'s name option is a substring match by default.
    const header = maker.page.getByRole('region', { name: 'This item', exact: true });
    await expect(header).toContainText('In progress');

    // `23-ERD-AND-STATE-MACHINES` §5 requires two facts to enter `blocked`, and the form asks
    // for exactly those two because it asks the machine rather than carrying its own copy.
    await maker.page.getByLabel('Move to').selectOption({ label: 'Blocked' });
    await expect(maker.page.getByLabel('What is blocking this')).toBeVisible();
    await expect(maker.page.getByLabel('What you need, and from whom')).toBeVisible();
    await expect(maker.page.getByLabel('How it was resolved')).toHaveCount(0);

    await maker.page.getByLabel('What is blocking this').fill(BLOCKER_REASON);
    await maker.page.getByLabel('What you need, and from whom').fill(BLOCKER_ASK);
    await maker.page.getByRole('button', { name: 'Move to Blocked' }).click();

    await expect(header).toContainText('Blocked');

    // A different person, a different screen, the same fact. The manager reads the project.
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto(`/northstar-studio/projects/${world().northstar.projectId}`);
    // The sentence, not the count: `healthSentence` says "One item is blocked" for one and
    // "2 items are blocked" for two, and another journey in this suite may block something in
    // this project tomorrow. The claim is that the panel reports a blockage at all.
    await expect(
      manager.page.getByRole('region', { name: 'How it is going', exact: true }),
    ).toContainText(/(One item is blocked|\d+ items are blocked)/u);
    // Which item, named. This is the count-free half of the claim.
    await expect(manager.page.getByRole('region', { name: 'Blockers', exact: true })).toContainText(
      world().northstar.workItemTitle,
    );

    // And the inbox — the work list filtered to one state. Reached by the screen's own
    // "Update work" action rather than by a fresh navigation, because that is the client-side
    // hop between these two screens: they share one `QueryClient`, and a shared cache entry
    // between the list's paged shape and the overview's array shape crashed both of them
    // until `workItemKeys` gave each its own key. A `page.goto` here would never see it.
    await manager.page.getByRole('link', { name: 'Update work' }).click();
    await expect(manager.page).toHaveURL(/\/northstar-studio\/work\?project=/u);
    const table = manager.page.getByRole('table');
    await expect(
      table.getByRole('link', { name: world().northstar.workItemTitle, exact: true }),
    ).toBeVisible();

    const filters = manager.page.getByRole('region', { name: 'Filters', exact: true });
    await filters.getByLabel('Blocked').check();
    await expect(
      table.getByRole('link', { name: world().northstar.workItemTitle, exact: true }),
    ).toBeVisible();

    await maker.context.close();
    await manager.context.close();
  });

  test('E2E-03b: the blocker is resolved and the work goes to review, and both screens follow', async ({
    browser,
  }) => {
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));
    const header = maker.page.getByRole('region', { name: 'This item', exact: true });
    await expect(header).toContainText('Blocked');

    // Leaving `blocked` costs the outcome — §5 will not take "unblocked" as an answer, and the
    // form asks for the one fact that move requires and no other.
    await maker.page.getByLabel('Move to').selectOption({ label: 'In progress' });
    await expect(maker.page.getByLabel('How it was resolved')).toBeVisible();
    await expect(maker.page.getByLabel('What is blocking this')).toHaveCount(0);
    await maker.page.getByLabel('How it was resolved').fill(BLOCKER_RESOLUTION);
    await maker.page.getByRole('button', { name: 'Move to In progress' }).click();
    await expect(header).toContainText('In progress');

    // Into review. This move requires nothing, and the screen says so rather than showing an
    // empty form a person would search for the missing field in.
    await maker.page.getByLabel('Move to').selectOption({ label: 'Internal review' });
    await expect(maker.page.getByText('This move needs nothing else from you')).toBeVisible();
    await maker.page.getByRole('button', { name: 'Move to Internal review' }).click();
    await expect(header).toContainText('Internal review');

    // The manager's two screens follow, and the blockers panel is empty again.
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto(`/northstar-studio/projects/${world().northstar.projectId}`);
    const blockers = manager.page.getByRole('region', { name: 'Blockers', exact: true });
    await expect(blockers).toContainText('Nothing is blocked.');
    await expect(blockers).not.toContainText(world().northstar.workItemTitle);

    // The inbox, both ways round. Asserted about *this* item rather than about the whole
    // filtered list: another journey's work item being blocked is not this journey's business.
    await manager.page.goto('/northstar-studio/work');
    const filters = manager.page.getByRole('region', { name: 'Filters', exact: true });
    await filters.getByLabel('Blocked').check();
    await expect(
      manager.page.getByRole('link', { name: world().northstar.workItemTitle, exact: true }),
    ).toHaveCount(0);

    await filters.getByLabel('Blocked').uncheck();
    await filters.getByLabel('Internal review').check();
    await expect(
      manager.page.getByRole('table').getByRole('link', {
        name: world().northstar.workItemTitle,
        exact: true,
      }),
    ).toBeVisible();

    await maker.context.close();
    await manager.context.close();
  });

  test('E2E-03c: review ends in done, and the completion time is kept rather than thrown away', async ({
    browser,
  }) => {
    // Added 2026-09-01 with 0013. Until then `done` asked for an owner and a completion
    // time and the database kept neither; this leg proves the screen asks, the API stores,
    // and the item's own page and the manager's list both read the stored fact back.
    const maker = await openAs(browser, world().northstar.designer.id);
    await maker.page.goto(workUrl('northstar-studio', world().northstar.workItemId));
    const header = maker.page.getByRole('region', { name: 'This item', exact: true });
    await expect(header).toContainText('Internal review');
    await expect(header).not.toContainText('Completed');

    await maker.page.getByLabel('Move to').selectOption({ label: 'Done' });
    // The owner opens filled with the item's current owner — the seed gives it to the
    // designer — and the time with now. Neither has to be typed; the time is corrected here to
    // when the work was actually finished, which is the point of asking.
    const ownerField = maker.page.getByLabel('Who owned this to completion');
    await expect(ownerField).toHaveValue(world().northstar.designer.id);
    const completedField = maker.page.getByLabel('When it was completed');
    await expect(completedField).not.toHaveValue('');
    // An hour before the run, to the minute — taken from the run's own clock, because the
    // API refuses a completion time in the future and a literal date would be one someday.
    const finishedAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60 * 60_000);
    await completedField.fill(finishedAt.toISOString().slice(0, 16));
    await maker.page.getByRole('button', { name: 'Move to Done', exact: true }).click();
    await expect(header).toContainText('Done');
    await expect(header).toContainText('Completed');

    // The stored fact, read from the API rather than inferred from the screen. The browser is
    // pinned to UTC by playwright.config.ts, so the local time typed above *is* the instant.
    const stored = await maker.context.request.get(
      `${API_URL}/v1/organizations/northstar-studio/work-items/${world().northstar.workItemId}`,
    );
    expect(stored.ok()).toBe(true);
    const body = (await stored.json()) as {
      state: string;
      ownerUserId: string | null;
      completedAt: string | null;
    };
    expect(body.state).toBe('done');
    expect(body.ownerUserId).toBe(world().northstar.designer.id);
    expect(body.completedAt).toBe(finishedAt.toISOString());

    // The manager's list agrees, under the Done filter.
    const manager = await openAs(browser, world().northstar.manager.id);
    await manager.page.goto('/northstar-studio/work');
    const filters = manager.page.getByRole('region', { name: 'Filters', exact: true });
    await filters.getByLabel('Done').check();
    await expect(
      manager.page.getByRole('table').getByRole('link', {
        name: world().northstar.workItemTitle,
        exact: true,
      }),
    ).toBeVisible();

    await maker.context.close();
    await manager.context.close();
  });
});

/**
 * Outside the serial group on purpose: a tenant-isolation journey that reports "did not run"
 * because a UI step above it flaked is a security check nobody read. It shares no state with
 * E2E-03 — the two organizations it reads are ones E2E-03 never touches.
 */
test.describe('the cross-tenant object-id journey', () => {
  test('AUTH-02: a foreign object id under a valid slug is told nothing exists', async ({
    browser,
  }) => {
    const member = await openAs(browser, world().northstar.designer.id);

    // An unrelated tenant's work item, borrowed into Northstar's own URL.
    await member.page.goto(workUrl('northstar-studio', world().brightops.workItemId));
    await expect(member.page.getByText('Could not load this work item')).toBeVisible();
    await expect(member.page.getByText('The requested resource was not found')).toBeVisible();
    await expect(member.page.getByText(world().brightops.workItemTitle)).toHaveCount(0);
    // Not a word of the record: no state, no audience, no version.
    await expect(member.page.getByRole('region', { name: 'This item', exact: true })).toHaveCount(
      0,
    );

    // The adversarial twin, whose work item carries the *same title* as Northstar's own. The
    // absence of a title proves nothing here, so the claim is that the page is the refusal.
    expect(world().twin.workItemTitle).toBe(world().northstar.workItemTitle);
    await member.page.goto(workUrl('northstar-studio', world().twin.workItemId));
    await expect(member.page.getByText('Could not load this work item')).toBeVisible();
    await expect(member.page.getByText('The requested resource was not found')).toBeVisible();
    await expect(member.page.getByRole('region', { name: 'This item', exact: true })).toHaveCount(
      0,
    );

    // The write, which no screen can reach because no screen renders. A route guard answers
    // the read; only the organization-scoped lookup inside the write path answers this, and
    // "zero side effects" is a claim about writes before it is a claim about reads. Sent as
    // the browser would send it — session cookie, CSRF header, real origin — so a refusal
    // cannot be the CSRF guard's rather than the tenant's. The code is asserted, not only the
    // status, for the same reason.
    const csrf = (await member.context.cookies(API_URL)).find(
      (cookie) => cookie.name === 'tmanage_session_csrf',
    );
    expect(csrf?.value).toBeTruthy();
    const write = await member.context.request.post(
      `${API_URL}/v1/organizations/northstar-studio/work-items/${world().brightops.workItemId}/transitions`,
      {
        headers: { 'x-csrf-token': csrf?.value as string, origin: WEB_URL },
        data: {
          version: 1,
          to: 'blocked',
          facts: { blockerReason: 'probe', blockerAsk: 'probe' },
        },
      },
    );
    expect(write.status()).toBe(404);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe('not_found');

    await member.context.close();

    // "Zero side effects", checked from the far side rather than inferred from the refusal:
    // BrightOps' owner opens their own item and finds it untouched, at the version it was
    // seeded with. The badge's whole text is asserted — `toContainText('v1')` would also be
    // satisfied by `v12`, which is precisely the outcome this line exists to rule out.
    const tarek = await openAs(browser, world().brightops.owner.id);
    await tarek.page.goto(workUrl('brightops-consulting', world().brightops.workItemId));
    const header = tarek.page.getByRole('region', { name: 'This item', exact: true });
    await expect(header).toContainText('In progress');
    await expect(header).toContainText('Internal');
    await expect(header.getByText('v1', { exact: true })).toBeVisible();

    await tarek.context.close();
  });
});
