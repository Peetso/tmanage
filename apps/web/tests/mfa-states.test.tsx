import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import MfaPage from '../src/app/sign-in/verify/page';

/**
 * **D15's defect on the second screen — a query string must not be able to claim a security
 * action happened.**
 *
 * `apps/web/src/app/sign-in/verify/page.tsx:16` read `?state=rate-limited` and passed the
 * comparison straight to `MfaChallengeScreen`, whose rate-limited branch
 * (`MfaChallengeScreen.tsx:117-120`) ends "The attempt was recorded in the audit log."
 * `04-SECURITY-PRIVACY` §8 makes that log an append-only record with a named actor and a
 * result, so the sentence is a statement about a security control. Anyone who could type
 * `/sign-in/verify?state=rate-limited` made the product assert, in its own voice, that a row
 * had been appended for them — when no request had been made, nothing had been refused and
 * nothing had been written.
 *
 * The fix is the one `/recover` took in D15 (`ddeb7d6`): the route reads no search parameters
 * at all. The distinction that matters is between the **component** API and the **route**.
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md` line 33 approves "rate limit" as an ID-02 state and
 * `screens.test.tsx` exercises it as a prop, which is legitimate — and, unlike ID-05's `sent`
 * and `completed`, this claim is one the application can actually substantiate: the API refuses
 * a flooded MFA or recovery-code attempt with 429 `rate_limited`
 * (`apps/api/src/modules/identity/authentication.controller.ts:252`) and writes the refusal to
 * the audit log first (`authentication.service.ts` `recordRefusal` / `record`). So the sentence
 * stays as approved copy, for a caller holding a real 429. What no caller may do is produce it
 * from eight characters in the address bar, and this file is where that is proved.
 *
 * ## Why the page is called through a cast
 *
 * `MfaPage` is an async server component and, after the fix, declares no props at all — that is
 * the fix. Next.js still passes it `searchParams` on every request, so the honest test hands it
 * exactly what the framework would and shows that nothing reaches the screen. TypeScript will
 * not let a zero-parameter function be called with an argument, so the call goes through one
 * narrowly-scoped cast rather than softening the page's signature for a test's benefit.
 */
type RoutePropsNextWouldPass = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const callRoute = MfaPage as unknown as (props?: RoutePropsNextWouldPass) => Promise<ReactElement>;

/** Render the route the way Next.js would invoke it for `?<query>`. */
async function renderRoute(query: Record<string, string | string[] | undefined>) {
  render(await callRoute({ searchParams: Promise.resolve(query) }));
}

/**
 * Every sentence the route must not produce. The audit-log claim is the defect itself; the
 * other two are the rest of the same alert, and they are listed because a fix that removed the
 * one sentence while still letting a URL raise a danger alert saying an account had been
 * throttled would be the same lie in a milder register.
 */
const RATE_LIMIT_CLAIMS: readonly RegExp[] = [
  /recorded in the audit log/,
  /Rate limited/,
  /Too many attempts/,
];

/** The page renders the challenge screen, and says of itself that it has nothing to verify. */
function expectHonestChallengeState() {
  expect(screen.getByRole('heading', { level: 1, name: /Confirm it’s you/ })).toBeInTheDocument();
  expect(screen.getByText('There is nothing to verify here')).toBeInTheDocument();
}

/** No sentence on the page asserts a refused attempt, whatever was asked for. */
function expectNoRateLimitClaim() {
  for (const claim of RATE_LIMIT_CLAIMS) {
    expect(screen.queryByText(claim)).toBeNull();
  }
}

/**
 * The rate-limited state also disables the two inputs and the button. A URL that cannot make
 * the claim but can still lock the form would be a lesser version of the same defect: the
 * screen would be behaving as though an attempt had been refused.
 */
function expectFormUsable() {
  expect(screen.getByLabelText(/Six-digit code/)).toBeEnabled();
}

describe('/sign-in/verify cannot be talked into claiming an attempt was refused', () => {
  it('does not report a throttled attempt or an audit row for ?state=rate-limited', async () => {
    await renderRoute({ state: 'rate-limited' });

    expect(screen.queryByText(/recorded in the audit log/)).toBeNull();
    expect(screen.queryByText(/Rate limited/)).toBeNull();
    expectFormUsable();
    expectHonestChallengeState();
  });

  it('renders the plain challenge for an unrecognised value', async () => {
    await renderRoute({ state: 'nonsense' });

    expectNoRateLimitClaim();
    expectFormUsable();
    expectHonestChallengeState();
  });

  it('renders the plain challenge when no parameter is supplied', async () => {
    await renderRoute({});

    expectNoRateLimitClaim();
    expectFormUsable();
    expectHonestChallengeState();
  });

  /**
   * Next.js hands a **repeated** parameter over as `string[]`. The pre-fix code compared that
   * array to a string with `===`, so `?state=rate-limited&state=rate-limited` happened to fall
   * through to the plain challenge — by accident, not by design. The case is kept because the
   * accident is exactly what a later refactor of the removed code would have got wrong.
   */
  it('renders the plain challenge for a repeated parameter', async () => {
    await renderRoute({ state: ['rate-limited', 'rate-limited'] });

    expectNoRateLimitClaim();
    expectFormUsable();
    expectHonestChallengeState();
  });

  /**
   * `?state=` is not the only parameter a stranger can invent, and the fix is not a denylist of
   * the one name that used to work. The route reads nothing, so nothing reaches the screen.
   */
  it('reads no other parameter either', async () => {
    await renderRoute({ rateLimited: 'true', state: 'rate-limited', locked: '1' });

    expectNoRateLimitClaim();
    expectFormUsable();
    expectHonestChallengeState();
  });

  it('renders the plain challenge when Next.js passes the route nothing at all', async () => {
    render(await callRoute());

    expectNoRateLimitClaim();
    expectFormUsable();
    expectHonestChallengeState();
  });
});
