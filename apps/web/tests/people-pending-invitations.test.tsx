import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminOverviewScreen } from '../src/components/screens/AdminOverviewScreen';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { initialsOfEmail } from '../src/components/people/PendingInvitations';

/**
 * 2026-10-31 live test (07-people): pending invitations were counted but listed nowhere, could not be
 * revoked or have their role changed, and the Control Center overview said "No invitations waiting".
 * Figma 446:35593 (list), 446:35821 (revoke confirm), 446:35866 (change invitation role).
 */

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const BUILT_IN = {
  roles: ['owner', 'org_admin', 'manager', 'member'].map((role) => ({
    role,
    kind: 'internal',
    capabilities: [],
    projectRole: false,
    assignable: true,
  })),
};

const INVITATIONS = [
  {
    id: 'inv-hana',
    email: 'hana@northstar.studio',
    role: 'member',
    invitedByUserId: 'u-maya',
    invitedByName: 'Maya Hassan',
    invitedByEmail: 'maya@northstar.studio',
    expiresAt: '2026-11-14T10:00:00Z',
    createdAt: '2026-10-31T10:00:00Z',
    isExpired: false,
  },
  {
    id: 'inv-old',
    email: 'old@example.test',
    role: 'member',
    invitedByUserId: 'u-maya',
    invitedByName: 'Maya Hassan',
    invitedByEmail: 'maya@northstar.studio',
    expiresAt: '2026-10-01T10:00:00Z',
    createdAt: '2026-09-17T10:00:00Z',
    isExpired: true,
  },
];

function routedClient(sent: Sent[], delivery: 'sent' | 'none' = 'sent') {
  const routed: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (method !== 'GET') sent.push({ method, path: url.pathname, body });
    const reply = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    // Plan 60: AI employees are not offered here (the API answers 404 while they are off).
    if (url.pathname.includes('/ai-employees'))
      return reply({ error: { code: 'not_found', message: 'Not found', correlationId: 'c' } }, 404);
    if (url.pathname.endsWith('/people')) {
      return reply({
        people: [
          {
            userId: 'u-maya',
            displayName: 'Maya Hassan',
            role: 'owner',
            status: 'active',
            projectCount: 1,
            membershipId: 'm-maya',
            teams: [],
            openCommitments: 0,
            overdueCommitments: 0,
            declared: null,
          },
        ],
        nextAfter: null,
      });
    }
    if (url.pathname.endsWith('/admin/invitations')) return reply({ invitations: INVITATIONS });
    if (url.pathname.endsWith('/revoke') && method === 'POST') return reply(null, 204);
    if (url.pathname.endsWith('/reissues') && method === 'POST') {
      const role = (body as { role?: string } | undefined)?.role ?? 'member';
      return reply(
        {
          invitation: { id: 'inv-new', email: 'hana@northstar.studio', role },
          token: 'tok-new',
          delivery,
        },
        201,
      );
    }
    if (url.pathname.endsWith('/admin/roles/built-in')) return reply(BUILT_IN);
    if (url.pathname.endsWith('/admin/roles')) return reply({ roles: [] });
    if (url.pathname.endsWith('/admin/overview')) {
      return reply({
        activeMembers: 1,
        seatsUsed: 1,
        storageBytesUsed: 0,
        auditWindowDays: 30,
        auditEventsWindow: 0,
        openOffboardings: 0,
        computedAt: '2026-10-31T10:00:00Z',
      });
    }
    return reply({
      connections: [],
      viewerName: 'Maya Hassan',
      owner: true,
      apps: [],
      events: [],
      templates: [],
      enforce2fa: false,
      ipAllowlist: [],
    });
  }) as typeof globalThis.fetch;
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

function queries() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar', name: 'Northstar Studio', role: 'owner' }],
  );
  return client;
}

function mountPeople(delivery: 'sent' | 'none' = 'sent') {
  const sent: Sent[] = [];
  render(
    <QueryClientProvider client={queries()}>
      <PeopleDirectoryScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={routedClient(sent, delivery)}
      />
    </QueryClientProvider>,
  );
  return sent;
}

describe('Members and roles — pending invitations', () => {
  it('lists each pending invitation with its role, inviter and expiry', async () => {
    mountPeople();
    const table = await screen.findByRole('table', { name: 'Invitations waiting · 2' });
    expect(within(table).getByText('hana@northstar.studio')).toBeTruthy();
    expect(within(table).getAllByText('Maya Hassan')).toHaveLength(2);
    expect(within(table).getByText('Expired')).toBeTruthy();
    // Plan 60 S1: the header counts people; the invitations count heads their own table.
    expect(await screen.findByText('1 person')).toBeTruthy();
    expect(initialsOfEmail('hana@northstar.studio')).toBe('HN');
  });

  it('revokes an invitation after the confirm', async () => {
    const sent = mountPeople();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for hana@northstar.studio' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke invitation' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke invitation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/v1/organizations/northstar/admin/invitations/inv-hana/revoke',
        body: undefined,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('changes the role by re-issuing the invitation with the new role', async () => {
    const sent = mountPeople();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Role offered to hana@northstar.studio: Member. Change role',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Change invitation role' });
    const confirm = within(dialog).getByRole('button', { name: 'Send new invitation' });
    expect(confirm).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Manager' }));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/v1/organizations/northstar/invitations/inv-hana/reissues',
        body: { role: 'manager' },
      }),
    );
  });

  it('resends with the same role and shows the link when no email went out', async () => {
    const sent = mountPeople('none');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for hana@northstar.studio' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/v1/organizations/northstar/invitations/inv-hana/reissues',
        body: {},
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Invitation link') as HTMLInputElement).value).toContain(
      '/invitations/tok-new',
    );
  });
});

describe('Control Center overview — invitations waiting', () => {
  it('counts the pending, unexpired invitations rather than the seat counters', async () => {
    render(
      <QueryClientProvider client={queries()}>
        <AdminOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={routedClient([])}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('1 invitation waiting')).toBeTruthy();
  });
});
