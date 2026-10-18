import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendPending } from '../src/components/screens/BackendPending';
import { MfaChallengeScreen } from '../src/components/screens/MfaChallengeScreen';
import { RecoveryScreen, type RecoveryState } from '../src/components/screens/RecoveryScreen';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { expectNoAxeViolations } from './axe';

/**
 * **Internal identifiers must not reach a person using the product.**
 *
 * The 2026-09-05 review's §7 asks for internal identifiers to be removed from customer-facing
 * copy. `BackendPending` — the notice a screen carries where its server side does not exist —
 * put one in a heading on sixteen screens: *"Not built yet — ID-002"*. `ID-002` is a row in
 * `28-SPRINT-TICKETS-AND-ESTIMATES.md`. A person reading a recovery screen cannot look it up,
 * cannot act on it, and is not the audience for it.
 *
 * The notice itself must stay. A screen whose form silently does nothing is worse than one
 * that says so. What changes is who the sentence is written for, and who sees the identifier:
 *
 * - **The identifier is for the team**, so it renders only when `NODE_ENV` is not
 *   `production` — the same mechanism `SignInScreen`'s `developmentSignInEnabled` already
 *   uses for its development-only panel, rather than a second one invented here.
 * - **The sentence is for the person**, so it says what is true, what it means for them, and
 *   what they can do instead. On recovery that last part is the whole point: "not built yet"
 *   left somebody locked out of their account with nowhere to go.
 *
 * ## What counts as an internal identifier here
 *
 * Three-digit ticket ids (`ID-002`, `CHAT-001`) and planning-pack file references
 * (`28-SPRINT-TICKETS`, `23-ERD`). Two-digit **screen** ids are deliberately excluded: the
 * identity shell renders `ID-05 · Recovery` in its eyebrow because the approved design export
 * draws exactly that ("ID-05 · RECOVERY · FOUR STATES" in
 * `TManage Screens - Public and Identity.dc.html`). Removing it would be a change to approved
 * design, which this ticket does not have the standing to make; it is recorded for the owner
 * instead.
 *
 * Neither pattern ends in `\b`. These run against `textContent`, which butts one element's
 * text against the next with no separator — `…— ID-002` followed by `No recovery email…`
 * reads as `ID-002No`, and a trailing word boundary would have silently matched nothing. It
 * did, in the first red run: four assertions passed against a page that said `ID-002`.
 */
const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d{3}(?!\d)/;
const PLANNING_FILE_REFERENCE = /\b\d{2}-[A-Z][A-Z-]{3,}/;

/** The fallback the recovery screen still owes a person whose email never arrives. */
const NEXT_STEP = /whoever administers your TManage workspace/;

const RECOVERY_STATES: readonly RecoveryState[] = [
  'request',
  'sent',
  'reset',
  'expired',
  'completed',
];

/** The states where a person can still be stuck: no link yet, or a dead one. */
const STUCK_STATES: readonly RecoveryState[] = ['request', 'sent', 'expired'];

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Everything the screen actually puts on the page, as one string. */
function textOf(container: Element): string {
  return container.textContent ?? '';
}

/**
 * Put the module under the same environment a shipped build runs in.
 *
 * `NODE_ENV` alone is not that environment. D19 makes a production build refuse to start
 * without `NEXT_PUBLIC_API_BASE_URL` — `resolveApiBaseUrl` throws
 * `PublicConfigError` — and `SignInScreen` and `MfaChallengeScreen` construct a browser API
 * client while rendering. Stubbing only `NODE_ENV` therefore tests a build that could not
 * exist, and the two screens most worth checking threw before rendering a word.
 *
 * The origin is the one `public-config.test.ts` uses for a valid https origin. It is never
 * called: no test here performs a request.
 */
function productionBuild(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.com');
}

describe('BackendPending keeps its ticket out of a production build', () => {
  it('renders no ticket id when NODE_ENV is production', () => {
    productionBuild();
    const { container } = render(
      <BackendPending ticket="ID-002">No recovery email is sent.</BackendPending>,
    );

    expect(textOf(container)).not.toMatch(TICKET_ID);
    expect(textOf(container)).not.toContain('ID-002');
  });

  it('still says the work is unfinished in production, in plain words', () => {
    productionBuild();
    render(<BackendPending ticket="ID-002">No recovery email is sent.</BackendPending>);

    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('No recovery email is sent.')).toBeInTheDocument();
  });

  it('keeps the ticket out of a development build too, unless a caller asks for it', () => {
    // Peter, 2026-10-18: the design is reviewed on the development server, and a ticket id is a
    // developer artefact on a screen a person uses.
    vi.stubEnv('NODE_ENV', 'development');
    const { container } = render(
      <BackendPending ticket="ID-002">No recovery email is sent.</BackendPending>,
    );

    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(textOf(container)).not.toMatch(TICKET_ID);
  });

  it('lets a caller decide either way, so a test never depends on the ambient environment', () => {
    const shown = render(
      <BackendPending ticket="ID-002" showTicket>
        Body.
      </BackendPending>,
    );
    expect(textOf(shown.container)).toContain('ID-002');

    const hidden = render(
      <BackendPending ticket="ID-002" showTicket={false}>
        Body.
      </BackendPending>,
    );
    expect(textOf(hidden.container)).not.toContain('ID-002');
  });
});

describe('ID-05 Recovery shows a person no internal identifier in production', () => {
  for (const state of RECOVERY_STATES) {
    it(`cites no ticket or planning file in the ${state} state`, () => {
      productionBuild();
      const { container } = render(<RecoveryScreen state={state} />);

      expect(textOf(container)).not.toMatch(TICKET_ID);
      expect(textOf(container)).not.toMatch(PLANNING_FILE_REFERENCE);
    });
  }

  it('keeps the ticket off the screen in development too (Peter, 2026-10-18)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { container } = render(<RecoveryScreen state="request" />);

    expect(textOf(container)).not.toContain('ID-002');
  });
});

describe('ID-05 Recovery gives a locked-out person a next step', () => {
  for (const state of STUCK_STATES) {
    it(`names who can let them back in, from the ${state} state`, () => {
      productionBuild();
      const { container } = render(<RecoveryScreen state={state} />);

      expect(textOf(container)).toMatch(NEXT_STEP);
    });
  }

  /**
   * The next step must be one this application can honestly offer. Nothing here has a support
   * address, a phone number or a promised turnaround, and inventing one would be the same
   * defect in a friendlier voice.
   */
  it('invents no support address, phone number or timeline', () => {
    productionBuild();
    const { container } = render(<RecoveryScreen state="request" />);
    const text = textOf(container);

    expect(text).not.toMatch(/support@|help@|@tmanage\.(com|io|app)/i);
    expect(text).not.toMatch(/\+\d[\d\s()-]{7,}/);
    expect(text).not.toMatch(/within \d+ (hour|day|business)/i);
  });

  it('still has no axe violation once the copy has changed', async () => {
    productionBuild();
    const { container } = render(<RecoveryScreen state="request" />);

    await expectNoAxeViolations(container);
  });
});

describe('the other identity screens carry no identifier in production either', () => {
  it('ID-01 Sign in', () => {
    productionBuild();
    const { container } = render(<SignInScreen developmentSignInEnabled={false} />);

    expect(textOf(container)).not.toMatch(TICKET_ID);
  });

  it('ID-02 MFA challenge', () => {
    productionBuild();
    const { container } = render(<MfaChallengeScreen />);

    expect(textOf(container)).not.toMatch(TICKET_ID);
  });
});
