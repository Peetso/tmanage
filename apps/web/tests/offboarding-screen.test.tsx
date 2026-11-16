import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { OffboardingScreen } from '../src/components/screens/OffboardingScreen';
import { expectNoAxeViolations } from './axe';

/** ADM-12/13 (x121) — the member offboarding screen: pick a member, preview access, confirm. */

const MEMBERS = {
  members: [
    { userId: 'u-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
    { userId: 'u-ada', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
  ],
  nextAfter: null,
};

interface Scenario {
  readonly impact: unknown;
  readonly impactStatus?: number;
  readonly offboard?: unknown;
  readonly offboardStatus?: number;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(scenario: Scenario) {
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/offboarding-impact')) {
      return Promise.resolve(respond(scenario.impact, scenario.impactStatus ?? 200));
    }
    if (url.includes('/offboard') && method === 'POST') {
      return Promise.resolve(
        respond(
          scenario.offboard ?? {
            error: { code: 'internal_error', message: 'no scenario', correlationId: 'c' },
          },
          scenario.offboardStatus ?? 200,
        ),
      );
    }
    if (url.includes('/members')) {
      return Promise.resolve(respond(MEMBERS));
    }
    return Promise.resolve(respond({}, 404));
  }) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={query}>
      <OffboardingScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

async function selectOmar() {
  await userEvent.type(screen.getByRole('combobox', { name: 'Member to offboard' }), 'Omar');
  await userEvent.click(await screen.findByRole('option', { name: /Omar Haddad/ }));
}

describe('OffboardingScreen', () => {
  it('previews the access a chosen member holds, then offboards behind an explicit acknowledgement', async () => {
    const { container } = mount({
      impact: {
        membershipId: 'm-omar',
        userId: 'u-omar',
        role: 'manager',
        status: 'active',
        projectMembershipCount: 2,
        ownedWorkItemCount: 5,
        offboardable: true,
        storageConnections: [],
      },
      offboard: {
        membershipId: 'm-omar',
        userId: 'u-omar',
        role: 'manager',
        status: 'offboarded',
        storageHandoverRequired: [],
      },
    });

    await selectOmar();

    // The impact preview reports the access and work the member holds.
    expect(await screen.findByText('2 project memberships')).toBeInTheDocument();
    expect(screen.getByText('5 work items')).toBeInTheDocument();

    // Inert until the irreversibility is acknowledged.
    expect(screen.getByRole('button', { name: /Offboard Omar Haddad/ })).toBeDisabled();

    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('checkbox', { name: /cannot be undone/i }));
    const offboardButton = screen.getByRole('button', { name: /Offboard Omar Haddad/ });
    expect(offboardButton).toBeEnabled();
    await userEvent.click(offboardButton);

    expect(await screen.findByText('Member offboarded')).toBeInTheDocument();
  });

  it('refuses to offer a second offboard for a member already terminal', async () => {
    mount({
      impact: {
        membershipId: 'm-ada',
        userId: 'u-ada',
        role: 'member',
        status: 'offboarded',
        projectMembershipCount: 0,
        ownedWorkItemCount: 0,
        offboardable: false,
        storageConnections: [],
      },
    });

    await userEvent.type(screen.getByRole('combobox', { name: 'Member to offboard' }), 'Ada');
    await userEvent.click(await screen.findByRole('option', { name: /Ada Okonkwo/ }));

    expect(await screen.findByText('Already offboarded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Offboard/ })).not.toBeInTheDocument();
  });

  it('renders the API refusal rather than a blank page when the offboard is rejected', async () => {
    mount({
      impact: {
        membershipId: 'm-omar',
        userId: 'u-omar',
        role: 'owner',
        status: 'active',
        projectMembershipCount: 1,
        ownedWorkItemCount: 0,
        offboardable: true,
        storageConnections: [],
      },
      offboard: {
        error: {
          code: 'forbidden',
          message: 'You do not have permission to perform this action',
          correlationId: 'c',
        },
      },
      offboardStatus: 403,
    });

    await selectOmar();
    // ADM-16: one membership reads as singular, not "1 project memberships".
    await screen.findByText('1 project membership');
    // ADM-16: the role is a label, not the stored lowercase code.
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.queryByText('owner')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /cannot be undone/i }));
    await userEvent.click(screen.getByRole('button', { name: /Offboard Omar Haddad/ }));

    await waitFor(() => expect(screen.getByText('Offboarding failed')).toBeInTheDocument());
  });

  it('shows the roster on focus, before anything is typed (ADM-16)', async () => {
    mount({
      impact: {
        membershipId: 'm-omar',
        userId: 'u-omar',
        role: 'manager',
        status: 'active',
        projectMembershipCount: 2,
        ownedWorkItemCount: 5,
        offboardable: true,
        storageConnections: [],
      },
    });

    const picker = await screen.findByRole('combobox', { name: 'Member to offboard' });
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.click(picker);

    // The list is there to click through without typing a single character.
    expect(await screen.findByRole('option', { name: /Omar Haddad/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Ada Okonkwo/ })).toBeInTheDocument();
  });
});
