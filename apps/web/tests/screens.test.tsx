import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  FIXTURE_INVITATION,
  FIXTURE_ORGANIZATIONS,
  FIXTURE_ORGANIZATION_DOMAIN,
  FIXTURE_OWNERS,
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

const SCREENS: readonly { name: string; render: () => React.ReactElement }[] = [
  { name: 'ID-01 Sign in', render: () => <SignInScreen developmentSignInEnabled /> },
  { name: 'ID-02 MFA', render: () => <MfaChallengeScreen /> },
  { name: 'ID-03 Invitation', render: () => <InvitationScreen invitation={FIXTURE_INVITATION} /> },
  {
    name: 'ID-04 Organization selector',
    render: () => <OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />,
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
    render: () => <FirstProjectScreen signedInAs={SIGNED_IN_AS} owners={FIXTURE_OWNERS} />,
  },
  {
    name: 'ON-04 Invite team',
    render: () => (
      <InviteTeamScreen
        signedInAs={SIGNED_IN_AS}
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
  it('disables every real sign-in method and names the ticket that builds them', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);

    expect(screen.getByRole('button', { name: /passkey/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /company SSO/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByText(/Not built yet — ID-002/)).toBeInTheDocument();
  });

  it('does not render the development panel when the API would not accept it', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.queryByLabelText(/User id/)).toBeNull();
  });

  it('keeps the email field left-to-right, as the specification requires', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.getByLabelText('Work email')).toHaveAttribute('dir', 'ltr');
  });

  it('links to recovery', () => {
    render(<SignInScreen developmentSignInEnabled={false} />);
    expect(screen.getByRole('link', { name: 'Forgot access' })).toHaveAttribute('href', '/recover');
  });
});

describe('ID-02 MFA', () => {
  it('uses one code field with a one-time-code autocomplete, not six boxes', () => {
    render(<MfaChallengeScreen />);
    const field = screen.getByLabelText(/Six-digit code/);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('refuses an incomplete code before it refuses anything else', async () => {
    const user = userEvent.setup();
    render(<MfaChallengeScreen />);
    await user.type(screen.getByLabelText(/Six-digit code/), '417');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByText('Enter all six digits.')).toBeInTheDocument();
  });

  it('says verification is unbuilt rather than accepting a complete code', async () => {
    const user = userEvent.setup();
    render(<MfaChallengeScreen />);
    await user.type(screen.getByLabelText(/Six-digit code/), '417295');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByText(/not built yet \(ID-002\)/)).toBeInTheDocument();
  });

  it('names no account when it is rate limited', () => {
    render(<MfaChallengeScreen rateLimited />);
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('gives each fallback control a distinct accessible name', () => {
    render(<MfaChallengeScreen />);
    expect(
      screen.getByRole('button', { name: 'Use a passkey on this device' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter a recovery code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask an admin to verify you' })).toBeInTheDocument();
  });
});

describe('ID-03 Invitation', () => {
  it('states that a client invitation is portal access, not team membership', () => {
    render(<InvitationScreen invitation={FIXTURE_INVITATION} />);
    expect(screen.getByText('This is client portal access')).toBeInTheDocument();
    expect(screen.getByText(/not membership of the delivery team/i)).toBeInTheDocument();
  });

  it('lists exactly what the person will see, and what they will not', () => {
    render(<InvitationScreen invitation={FIXTURE_INVITATION} />);
    for (const line of FIXTURE_INVITATION.willSee) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    expect(screen.getByText(FIXTURE_INVITATION.willNotSee)).toBeInTheDocument();
  });

  it('states the expiry and refuses to imply it can be extended', () => {
    render(<InvitationScreen invitation={FIXTURE_INVITATION} />);
    expect(screen.getByText(/expired links never grant access/i)).toBeInTheDocument();
  });

  it('does not render the internal alert for an internal invitation', () => {
    render(<InvitationScreen invitation={{ ...FIXTURE_INVITATION, audience: 'internal' }} />);
    expect(screen.queryByText('This is client portal access')).toBeNull();
  });
});

describe('ID-04 Organization selector', () => {
  it('filters in the browser, without sending the query anywhere', async () => {
    const user = userEvent.setup();
    render(<OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />);

    expect(screen.getByRole('link', { name: /Northstar Studio/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search organizations'), 'atlas');
    expect(screen.queryByRole('link', { name: /Northstar Studio/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Atlas Hospitality/ })).toBeInTheDocument();
  });

  it('says so when nothing matches, in a live region', async () => {
    const user = userEvent.setup();
    render(<OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />);
    await user.type(screen.getByLabelText('Search organizations'), 'zzz');
    expect(screen.getByText(/No organization matches/)).toBeInTheDocument();
  });

  it('marks a client organization as one', () => {
    render(<OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />);
    expect(screen.getByText('Client organization')).toBeInTheDocument();
    expect(screen.getByText('Internal member')).toBeInTheDocument();
  });

  it('links each organization to its own space', () => {
    render(<OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />);
    expect(screen.getByRole('link', { name: /Northstar Studio/ })).toHaveAttribute(
      'href',
      '/northstar/home',
    );
  });

  /**
   * `22` §3: "No cross-organization aggregated content in MVP." Every number on this screen
   * must belong to exactly one organization's row.
   */
  it('shows no total across organizations', () => {
    render(<OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />);
    const list = screen.getByRole('list');
    expect(within(list).getByText(/4 projects/)).toBeInTheDocument();
    expect(within(list).getByText(/1 project/)).toBeInTheDocument();
    expect(screen.queryByText(/5 projects/)).toBeNull();
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

  it('claims no availability, because nothing checked it', () => {
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByText(/cannot tell you yet whether it is taken/)).toBeInTheDocument();
    expect(screen.queryByText(/available/i)).toBeNull();
  });

  it('cannot be submitted, and names the ticket that would let it be', () => {
    render(<CreateOrganizationScreen signedInAs={SIGNED_IN_AS} />);
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();
    expect(screen.getByText(/Not built yet — TEN-001/)).toBeInTheDocument();
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
  it('calls the date a target and says what would make it a commitment', () => {
    render(<FirstProjectScreen signedInAs={SIGNED_IN_AS} owners={FIXTURE_OWNERS} />);
    expect(screen.getByLabelText(/Target date/)).toBeInTheDocument();
    expect(screen.getByText(/target, not a commitment/i)).toBeInTheDocument();
  });

  it('warns about a date in the past without refusing it', async () => {
    const user = userEvent.setup();
    render(<FirstProjectScreen signedInAs={SIGNED_IN_AS} owners={FIXTURE_OWNERS} />);
    await user.type(screen.getByLabelText(/Target date/), '2000-01-01');
    expect(screen.getByText(/That date has passed/)).toBeInTheDocument();
  });

  it('states that new content starts internal', () => {
    render(<FirstProjectScreen signedInAs={SIGNED_IN_AS} owners={FIXTURE_OWNERS} />);
    expect(screen.getByText('Default audience: internal')).toBeInTheDocument();
  });

  it('offers every owner it was given', () => {
    render(<FirstProjectScreen signedInAs={SIGNED_IN_AS} owners={FIXTURE_OWNERS} />);
    const select = screen.getByLabelText(/Project owner/);
    expect(within(select).getAllByRole('option')).toHaveLength(FIXTURE_OWNERS.length);
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
        organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
        existingMembers={FIXTURE_EXISTING_MEMBERS}
      />,
    );
  }

  it('accepts a colleague and counts them', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'maya@northstar.studio');
    expect(screen.getByRole('button', { name: 'Send 1 invitation' })).toBeInTheDocument();
  });

  it('redirects an outside address to a client organization', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addAddress(user, 'salma@atlashospitality.com');
    expect(screen.getByText(/invited as a client organization/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invitations' })).toBeInTheDocument();
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
    expect(screen.getByText(/They cannot change roles, publish to clients/)).toBeInTheDocument();
  });

  it('changes the preview when the role changes', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    expect(screen.getByText('Invite people and change their roles')).toBeInTheDocument();
    expect(screen.getByText('Cannot delete the organization.')).toBeInTheDocument();
  });
});
