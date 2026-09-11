import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import RecoverPage from '../src/app/recover/page';

/**
 * **D15 — a query string must not be able to claim a security action happened.**
 *
 * The 2026-09-05 production review recorded, against `apps/web/src/app/recover/page.tsx:3`
 * and `apps/web/src/components/screens/RecoveryScreen.tsx:113`, that `/recover?state=completed`
 * rendered "Access restored", "Your other sessions were signed out" and "The event was written
 * to the audit log". No recovery operation establishes any of those. ID-002 owns recovery and
 * has not been built, so there is nothing in this application that could have signed a session
 * out or appended an audit row — the page was telling a person, in the product's own voice,
 * that their account was safe on the strength of eight characters they typed into the address
 * bar.
 *
 * `screens.test.tsx` covers the four states as a **component** API, which is legitimate: `41`
 * line 36 approves all four for ID-05 and the design must stay reviewable. This file covers the
 * **route**, which is the part a stranger can reach, and asserts the acceptance sentence from
 * the review: changing query parameters cannot fabricate recovery, email-send,
 * session-revocation, or audit outcomes.
 *
 * ## Why the page is called through a cast
 *
 * `RecoverPage` is an async server component and, after the fix, declares no props at all —
 * that is the fix. Next.js still passes it `searchParams` for every request, so the honest
 * test is to hand it exactly what the framework would hand it and show that nothing reaches the
 * screen. TypeScript will not let a zero-parameter function be called with an argument, so the
 * call goes through one narrowly-scoped cast rather than by softening the page's signature for
 * the benefit of a test.
 */
type RoutePropsNextWouldPass = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const callRoute = RecoverPage as unknown as (
  props?: RoutePropsNextWouldPass,
) => Promise<ReactElement>;

/** Render the route the way Next.js would invoke it for `?<query>`. */
async function renderRoute(query: Record<string, string | string[] | undefined>) {
  render(await callRoute({ searchParams: Promise.resolve(query) }));
}

/**
 * The three sentences D15 is about, each one a claim about a security control that only a real
 * server operation could substantiate.
 */
const OUTCOME_CLAIMS: readonly RegExp[] = [
  /Access restored/,
  /Your other sessions were signed out/,
  /written to the audit log/,
  /A link may be on its way/,
];

/** The page renders `request`, and says of itself that recovery is not built. */
function expectHonestRequestState() {
  expect(screen.getByRole('heading', { level: 1, name: 'Recover access' })).toBeInTheDocument();
  expect(screen.getByText(/Not built yet — ID-002/)).toBeInTheDocument();
  expect(screen.getByText(/No recovery email is sent/)).toBeInTheDocument();
}

/** No sentence on the page asserts an outcome, whatever was asked for. */
function expectNoOutcomeClaim() {
  for (const claim of OUTCOME_CLAIMS) {
    expect(screen.queryByText(claim)).toBeNull();
  }
}

describe('D15 /recover cannot be talked into claiming an outcome', () => {
  it('does not report restored access, ended sessions or an audit row for ?state=completed', async () => {
    await renderRoute({ state: 'completed' });

    expect(screen.queryByText(/Access restored/)).toBeNull();
    expect(screen.queryByText(/Your other sessions were signed out/)).toBeNull();
    expect(screen.queryByText(/written to the audit log/)).toBeNull();
    expectHonestRequestState();
  });

  it('does not report a dispatched email for ?state=sent', async () => {
    await renderRoute({ state: 'sent' });

    expect(screen.queryByText(/A link may be on its way/)).toBeNull();
    expectHonestRequestState();
  });

  it('renders the request state for ?state=expired', async () => {
    await renderRoute({ state: 'expired' });

    expectNoOutcomeClaim();
    expectHonestRequestState();
  });

  it('renders the request state for an unrecognised value', async () => {
    await renderRoute({ state: 'nonsense' });

    expectNoOutcomeClaim();
    expectHonestRequestState();
  });

  it('renders the request state when no parameter is supplied', async () => {
    await renderRoute({});

    expectNoOutcomeClaim();
    expectHonestRequestState();
  });

  /**
   * Next.js hands a **repeated** parameter over as `string[]`. The pre-fix code compared that
   * array against a list of strings with `.find()`, so `?state=completed&state=completed`
   * happened to fall through to `request` — by accident, not by design. The case is kept
   * because the accident is exactly the kind of thing a later refactor of the removed code
   * would have got wrong.
   */
  it('renders the request state for a repeated parameter', async () => {
    await renderRoute({ state: ['completed', 'completed'] });

    expectNoOutcomeClaim();
    expectHonestRequestState();
  });

  it('renders the request state when Next.js passes the route nothing at all', async () => {
    render(await callRoute());

    expectNoOutcomeClaim();
    expectHonestRequestState();
  });
});
