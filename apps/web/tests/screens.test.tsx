import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiClient } from '../src/lib/api/client';
import { DELIVERABLE_STATES, WORK_ITEM_STATES } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import { CreateOrganizationScreen } from '../src/components/screens/CreateOrganizationScreen';
import { FirstProjectScreen } from '../src/components/screens/FirstProjectScreen';
import { InvitationScreen } from '../src/components/screens/InvitationScreen';
import { InviteTeamScreen } from '../src/components/screens/InviteTeamScreen';
import { MfaChallengeScreen } from '../src/components/screens/MfaChallengeScreen';
import { OperatingTemplateScreen } from '../src/components/screens/OperatingTemplateScreen';
import { OrganizationSelectorScreen } from '../src/components/screens/OrganizationSelectorScreen';
import { RecoveryScreen } from '../src/components/screens/RecoveryScreen';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import {
  FIXTURE_EXISTING_MEMBERS,
  FIXTURE_ORGANIZATION_DOMAIN,
  FIXTURE_SIGNED_IN_AS,
} from '../src/lib/fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * Every screen WEB-001 delivers, mounted.
 *
 * Two assertions apply to all of them and are made in one place: exactly one `<h1>`, and no
 * axe violation that jsdom can detect. Everything else is specific to the screen and states a
 * rule from `22-SCREEN-BY-SCREEN` §3 that the screen would be wrong without.
 */

const SIGNED_IN_AS = FIXTURE_SIGNED_IN_AS;

/**
 * A query client with retries off.
 *
 * The production client retries a 5xx twice; a test asserting an error state would wait for
 * two backoffs before the state it is waiting for exists.
 */
function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * An `ApiClient` that answers every list this file's screens ask for, with one row where a
 * row is needed and none where it is not.
 *
 * `ID-04` wants organizations and renders its empty state for `[]`; `ON-03` wants workspaces
 * and cannot submit without one. One body carrying both keys is simpler than routing on the
 * URL, and neither screen reads the other's key.
 */
function emptyDirectoryClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organizations: [],
            workspaces: [{ id: 'ws-1', name: 'Northstar Studio', createdAt: NOW }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

/**
 * A client that answers `ID-03`'s preview with a real one.
 *
 * `emptyDirectoryClient` answers every request with the same object, which for this screen is
 * a 200 carrying the wrong shape — so `Avatar` was handed `undefined` and threw *after* the
 * assertions had passed. Vitest reported "262 passed" and "1 error" in the same breath, which
 * is the shape of a false positive: a green test beside an unhandled exception.
 */
function invitationPreviewClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organizationName: 'Northstar Studio',
            inviterName: 'Omar Adel',
            inviterEmail: 'omar@northstar.studio',
            role: 'member',
            audience: 'internal',
            clientOrganizationName: null,
            invitedAt: '2026-08-26T00:00:00.000Z',
            expiresAt: '2026-09-09T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

const NOW = '2026-08-26T00:00:00.000Z';

const SCREENS: readonly { name: string; render: () => React.ReactElement }[] = [
  { name: 'ID-01 Sign in', render: () => <SignInScreen developmentSignInEnabled /> },
  { name: 'ID-02 MFA', render: () => <MfaChallengeScreen /> },
  {
    name: 'ID-03 Invitation',
    // Resolves its own invitation as of TEN-003, so it needs a query client and a fetch that
    // answers. What it does with the answer is covered in `invitation-flow.test.tsx`; here it
    // only has to mount for the shared landmark and axe assertions, which it does in its
    // loading state — that state carries the `<h1>` too, deliberately.
    render: () =>
      withQuery(<InvitationScreen token={'a'.repeat(43)} client={invitationPreviewClient()} />),
  },
  {
    name: 'ID-04 Organization selector',
    // Fetches its own list as of TEN-001, so it needs a query client and a fetch that
    // answers. The list's behaviour is covered in `organization-flow.test.tsx`; here the
    // screen only has to mount for the shared landmark and axe assertions.
    render: () => withQuery(<OrganizationSelectorScreen client={emptyDirectoryClient()} />),
  },
  { name: 'ID-05 Recovery', render: () => <RecoveryScreen state="request" /> },
  {
    name: 'ON-01 Create organization',
    render: () => <CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />,
  },
  {
    name: 'ON-02 Operating template',
    render: () => <OperatingTemplateScreen signedInAs={SIGNED_IN_AS} />,
  },
  {
    name: 'ON-03 First project',
    // Fetches the organization's workspaces as of PROJ-001, so it needs a query client and a
    // fetch that answers. The behaviour is covered in `project-flow.test.tsx`.
    render: () =>
      withQuery(
        <FirstProjectScreen
          signedInAs={SIGNED_IN_AS}
          organizationSlug="northstar"
          client={emptyDirectoryClient()}
        />,
      ),
  },
  {
    name: 'ON-04 Invite team',
    render: () => (
      <InviteTeamScreen
        signedInAs={SIGNED_IN_AS}
        organizationSlug="northstar"
        organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
        existingMembers={FIXTURE_EXISTING_MEMBERS}
      />
    ),
  },
];

describe.each(SCREENS)('$name', ({ render: renderScreen }) => {
  it('renders exactly one first-level heading', () => {
    render(renderScreen());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(renderScreen());
    await expectNoAxeViolations(container);
  });

  it('offers a skip link to the main landmark', () => {
    render(renderScreen());
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#tm-main',
    );
  });
});

describe('ID-01 Sign in', () => {
  it('offers a real email and password form', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);

    expect(screen.getByLabelText(/Work email/)).toBeEnabled();
    expect(screen.getByLabelText(/^Password/)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('still disables the two methods that are not built, and names why', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);

    expect(screen.getByRole('button', { name: /passkey/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /company SSO/i })).toBeDisabled();
    expect(screen.getByText(/Not built yet — ID-002 · passkeys and SSO/)).toBeInTheDocument();
  });

  it('does not render the development panel when the API would not accept it', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.queryByLabelText(/User id/)).toBeNull();
  });

  it('keeps the email field left-to-right, as the specification requires', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.getByLabelText(/Work email/)).toHaveAttribute('dir', 'ltr');
  });

  it('links to recovery', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.getByRole('link', { name: 'Forgot access' })).toHaveAttribute('href', '/recover');
  });
});

describe('ID-02 MFA', () => {
  it('uses one code field with a one-time-code autocomplete, not six boxes', () => {
    render(<MfaChallengeScreen challengeToken="c1.mfa.u.1.sig" />);
    const field = screen.getByLabelText(/Six-digit code/);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('refuses an incomplete code before it sends anything', async () => {
    const user = userEvent.setup();
    render(<MfaChallengeScreen challengeToken="c1.mfa.u.1.sig" />);
    await user.type(screen.getByLabelText(/Six-digit code/), '417');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByText(/Enter all six digits/)).toBeInTheDocument();
  });

  it('offers a recovery code as a distinct method, not as a guess from the shape', async () => {
    const user = userEvent.setup();
    render(<MfaChallengeScreen challengeToken="c1.mfa.u.1.sig" />);

    await user.click(screen.getByRole('radio', { name: /A recovery code/ }));
    expect(screen.getByLabelText(/Recovery code/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Six-digit code/)).toBeNull();
  });

  it('says so, and refuses to submit, when opened without a challenge', async () => {
    const user = userEvent.setup();
    render(<MfaChallengeScreen />);

    expect(screen.getByText('There is nothing to verify here')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    await user.type(screen.getByLabelText(/Six-digit code/), '417295');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
  });

  it('names no account when it is rate limited', () => {
    render(<MfaChallengeScreen challengeToken="c1.mfa.u.1.sig" rateLimited />);
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('names the factor from the challenge as device context', () => {
    render(<MfaChallengeScreen challengeToken="c1.mfa.u.1.sig" factorLabel="Omar’s iPhone" />);
    expect(screen.getByText('Omar’s iPhone')).toBeInTheDocument();
  });
});

describe('ID-05 Recovery', () => {
  it('never confirms whether an account exists', () => {
    render(<RecoveryScreen state="sent" />);
    expect(screen.getByText(/If an account exists for that address/)).toBeInTheDocument();
  });

  it('refuses to extend an expired link and says why', () => {
    render(<RecoveryScreen state="expired" />);
    expect(screen.getByText(/we do not extend recovery links/i)).toBeInTheDocument();
  });

  it('reports that other sessions were ended once recovery completed', () => {
    render(<RecoveryScreen state="completed" />);
    expect(screen.getByText(/Your other sessions were signed out/)).toBeInTheDocument();
  });
});

describe('ON-01 Create organization', () => {
  it('derives the workspace address from the name as it is typed', async () => {
    const user = userEvent.setup();
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);

    await user.type(screen.getByLabelText(/Organization name/), 'Northstar Studio');
    expect(screen.getByLabelText(/Workspace address/)).toHaveValue('northstar-studio');
  });

  it('stops deriving once the address has been edited by hand', async () => {
    const user = userEvent.setup();
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);

    const name = screen.getByLabelText(/Organization name/);
    const slug = screen.getByLabelText(/Workspace address/);

    await user.type(name, 'Northstar');
    await user.clear(slug);
    await user.type(slug, 'nstar');
    await user.type(name, ' Studio');

    expect(slug).toHaveValue('nstar');
  });

  it('reports an address the server could not accept', async () => {
    const user = userEvent.setup();
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    const slug = screen.getByLabelText(/Workspace address/);
    await user.type(slug, 'Not Valid');
    expect(screen.getByText(/Use lowercase letters, numbers and hyphens only/)).toBeInTheDocument();
  });

  it('still claims no availability before it is submitted', () => {
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByText(/decided when you create the organization/)).toBeInTheDocument();
    // No green tick. The unique key decides, on submit.
    expect(screen.queryByText(/^available$/i)).toBeNull();
  });

  it('can be submitted now that TEN-001 has landed', () => {
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeEnabled();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
  });

  it('bounds the name field at the width of the column behind it', () => {
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByLabelText(/Organization name/)).toHaveAttribute('maxlength', '190');
  });
});

describe('ON-02 Operating template', () => {
  it('offers the four templates the specification names', () => {
    render(<OperatingTemplateScreen signedInAs={SIGNED_IN_AS} />);
    for (const name of [
      'Agency delivery',
      'Software studio',
      'Consulting engagement',
      'Blank later',
    ]) {
      expect(screen.getByRole('radio', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  /**
   * The preview is generated from `@tmanage/domain`, so it cannot describe a workflow the
   * system does not run. If a state is added to the machine, this assertion is what notices.
   */
  it('previews the real work-item states, in order', () => {
    render(<OperatingTemplateScreen signedInAs={SIGNED_IN_AS} />);
    const flow = screen.getByRole('list', { name: 'Work item states' });
    const rendered = within(flow)
      .getAllByRole('listitem')
      // `StateCapsule` prefixes a decorative glyph — law 3 of the token export is that a
      // state carries a shape as well as a word — so the shape is stripped before comparing.
      .map((item) =>
        item.textContent
          ?.replace(/[^A-Za-z ]/g, '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_'),
      );
    expect(rendered).toEqual([...WORK_ITEM_STATES]);
  });

  it('previews the deliverable states only for a template with a client gate', async () => {
    const user = userEvent.setup();
    render(<OperatingTemplateScreen signedInAs={SIGNED_IN_AS} />);

    expect(screen.getByText(new RegExp(`${DELIVERABLE_STATES.length} states`))).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Software studio/ }));
    expect(screen.getByText(/no publication step/)).toBeInTheDocument();
  });

  it('says the template is a workflow rather than a theme', () => {
    render(<OperatingTemplateScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByText(/workflow, not a theme/)).toBeInTheDocument();
  });
});

describe('ON-03 First project', () => {
  const renderFirstProject = () =>
    withQuery(
      <FirstProjectScreen
        signedInAs={SIGNED_IN_AS}
        organizationSlug="northstar"
        client={emptyDirectoryClient()}
      />,
    );

  it('calls the date a target and says what would make it a commitment', () => {
    render(renderFirstProject());
    expect(screen.getByLabelText(/Target date/)).toBeInTheDocument();
    expect(screen.getByText(/target, not a commitment/i)).toBeInTheDocument();
  });

  it('warns about a date in the past without refusing it', async () => {
    const user = userEvent.setup();
    render(renderFirstProject());
    await user.type(screen.getByLabelText(/Target date/), '2000-01-01');
    expect(screen.getByText(/That date has passed/)).toBeInTheDocument();
  });

  it('states that new content starts internal', () => {
    render(renderFirstProject());
    expect(screen.getByText('Default audience: internal')).toBeInTheDocument();
  });

  it('states the owner rather than offering a picker that is a fiction', () => {
    render(renderFirstProject());
    expect(screen.getByText('Project owner')).toBeInTheDocument();
    expect(screen.getByText(SIGNED_IN_AS)).toBeInTheDocument();
    // No select. There is no endpoint that lists the people in an organization.
    expect(screen.queryByRole('combobox', { name: /owner/i })).toBeNull();
  });
});

describe('ON-04 Invite team', () => {
  async function addAddress(user: ReturnType<typeof userEvent.setup>, email: string) {
    await user.type(screen.getByLabelText('Email address'), email);
    await user.click(screen.getByRole('button', { name: 'Add to the list' }));
  }

  function renderScreen() {
    render(
      <InviteTeamScreen
        signedInAs={SIGNED_IN_AS}
        organizationSlug="northstar"
        organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
        existingMembers={FIXTURE_EXISTING_MEMBERS}
        client={emptyDirectoryClient()}
      />,
    );
  }

  it('accepts a colleague and counts them', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'maya@northstar.studio');
    // "Create", not "Send". Nothing emails an invitation — the screen shows the link and
    // says to send it by hand — so a button promising delivery would be describing something
    // that does not happen.
    expect(screen.getByRole('button', { name: 'Create 1 invitation' })).toBeInTheDocument();
  });

  it('redirects an outside address to a client organization', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'salma@atlashospitality.com');
    expect(screen.getByText(/invited as a client organization/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create invitations' })).toBeInTheDocument();
  });

  it('spots an existing member inline', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'karim@northstar.studio');
    expect(screen.getByText(/No second invitation will be sent/)).toBeInTheDocument();
  });

  it('refuses a malformed address before it reaches the list', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'not-an-address');
    expect(screen.getByText(/does not look like an email address/)).toBeInTheDocument();
    expect(screen.getByText('Nobody added yet')).toBeInTheDocument();
  });

  it('removes a row when asked', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'maya@northstar.studio');
    await user.click(screen.getByRole('button', { name: 'Remove maya@northstar.studio' }));
    expect(screen.getByText('Nobody added yet')).toBeInTheDocument();
  });

  it('previews what the selected role grants and what it withholds', () => {
    renderScreen();
    expect(screen.getByText(/Cannot change roles, publish to clients/)).toBeInTheDocument();
  });

  it('changes the preview when the role changes', async () => {
    const user = userEvent.setup();
    renderScreen();
    // `org_admin`, not `admin`. The screen shipped offering `admin` and `viewer`, and
    // neither is a role this system has — `INTERNAL_ROLES` decides, and `lib/roles.ts` is
    // keyed by it so the list cannot drift again without a type error.
    await user.selectOptions(screen.getByLabelText('Role'), 'org_admin');
    expect(screen.getByText('Invite people and change their roles')).toBeInTheDocument();
    expect(
      screen.getByText('Cannot delete the organization or change billing.'),
    ).toBeInTheDocument();
  });
});
