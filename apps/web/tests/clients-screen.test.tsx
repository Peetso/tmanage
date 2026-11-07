import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ClientsScreen } from '../src/components/screens/ClientsScreen';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * Q1 — the Clients screen (Figma t5-a) and Invite a client (t5-b) over the BK1 routes. The fake
 * fetch answers by method and path and records every call, so a test can assert both what is
 * drawn and what was sent. Labels are read through `translate` so the assertions hold before and
 * after the i18n-Q1 fragment is merged into the catalog.
 */
const label = (key: string) => translate('en-US', key as MessageKey);

const NOW = Date.parse('2026-10-22T12:00:00Z');

const ORGANIZATIONS = [
  { id: 'co-atlas', name: 'Atlas Hospitality', createdAt: '', updatedAt: '', archivedAt: null },
  { id: 'co-cedar', name: 'Cedar Foods', createdAt: '', updatedAt: '', archivedAt: null },
  { id: 'co-nile', name: 'Nile Robotics', createdAt: '', updatedAt: '', archivedAt: null },
  {
    id: 'co-meridian',
    name: 'Meridian Press',
    createdAt: '',
    updatedAt: '',
    archivedAt: '2026-06-10T00:00:00Z',
  },
];

function invitation(over: Record<string, unknown>) {
  return {
    id: 'inv',
    email: 'x@example.test',
    role: 'client_reviewer',
    clientOrganizationId: 'co-atlas',
    status: 'pending',
    expiresAt: '2026-11-30T00:00:00Z',
    invitedByUserId: 'u-1',
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: '2026-10-20T09:00:00Z',
    ...over,
  };
}

const INVITATIONS: Record<string, unknown[]> = {
  'co-atlas': [],
  'co-cedar': [
    invitation({
      id: 'inv-nour',
      email: 'nour@cedarfoods.com',
      role: 'client_admin',
      clientOrganizationId: 'co-cedar',
      createdAt: '2026-10-22T08:00:00Z',
    }),
  ],
  'co-nile': [
    invitation({
      id: 'inv-ahmed',
      email: 'ahmed@nilerobotics.io',
      role: 'client_viewer',
      clientOrganizationId: 'co-nile',
      status: 'expired',
      expiresAt: '2026-10-01T00:00:00Z',
    }),
  ],
  'co-meridian': [],
};

const MEMBERSHIPS: Record<string, unknown[]> = {
  'co-atlas': [
    {
      id: 'm1',
      clientOrganizationId: 'co-atlas',
      userId: 'a',
      role: 'client_admin',
      status: 'active',
    },
    {
      id: 'm2',
      clientOrganizationId: 'co-atlas',
      userId: 'b',
      role: 'client_viewer',
      status: 'active',
    },
    {
      id: 'm3',
      clientOrganizationId: 'co-atlas',
      userId: 'c',
      role: 'client_viewer',
      status: 'active',
    },
  ],
  'co-cedar': [],
  'co-nile': [],
  'co-meridian': [],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mount() {
  const calls: Call[] = [];
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/v1/organizations/northstar', '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });

    if (method === 'GET' && path === '/client-organizations') {
      return reply({ clientOrganizations: ORGANIZATIONS });
    }
    const invitations = /^\/client-organizations\/([^/]+)\/invitations$/.exec(path);
    if (method === 'GET' && invitations) {
      return reply({ invitations: INVITATIONS[invitations[1]!] ?? [] });
    }
    if (method === 'GET' && path === '/client-memberships') {
      const id = url.searchParams.get('clientOrganizationId') ?? '';
      return reply({ clientMemberships: MEMBERSHIPS[id] ?? [] });
    }
    if (method === 'GET' && path === '/projects') {
      return reply({
        projects: [{ id: 'p-web', name: 'Website relaunch', archivedAt: null }],
      });
    }
    if (method === 'POST' && path === '/client-organizations') {
      return reply({ id: 'co-new', name: (body as { name: string }).name, archivedAt: null }, 201);
    }
    if (method === 'POST' && path === '/invitations') {
      return reply(
        { invitation: invitation({ id: 'inv-new' }), token: 'tok-1', delivery: 'none' },
        201,
      );
    }
    if (method === 'POST' && /\/reissues$/.test(path)) {
      return reply(
        { invitation: invitation({ id: 'inv-re' }), token: 'tok-2', delivery: 'sent' },
        201,
      );
    }
    if (method === 'POST' && /^\/projects\/[^/]+\/clients$/.test(path)) {
      return reply({ id: 's1', projectId: 'p-web', clientOrganizationId: 'x', createdAt: '' }, 201);
    }
    return reply({});
  }) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <ClientsScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('ClientsScreen', () => {
  it('lists the client organizations and the pending invitations of every company', async () => {
    mount();

    const organizations = await screen.findByRole('list', {
      name: label('Clients.organizationsTitle'),
    });
    expect(within(organizations).getByText('Atlas Hospitality')).toBeTruthy();
    expect(within(organizations).getByText('Meridian Press')).toBeTruthy();

    const invitations = await screen.findByRole('list', {
      name: label('Clients.invitationsTitle'),
    });
    expect(await within(invitations).findByText('nour@cedarfoods.com')).toBeTruthy();
    expect(within(invitations).getByText('ahmed@nilerobotics.io')).toBeTruthy();
    expect(within(invitations).getByText(label('Clients.roleAdmin'))).toBeTruthy();
    expect(within(invitations).getByText(label('Clients.roleViewer'))).toBeTruthy();
  });

  it('derives each status pill from archive, pending invitations and active people', async () => {
    mount();

    const organizations = await screen.findByRole('list', {
      name: label('Clients.organizationsTitle'),
    });
    const rowOf = (name: string) => within(organizations).getByText(name).closest('li')!;

    await waitFor(() =>
      expect(within(rowOf('Atlas Hospitality')).getByText(label('Clients.statusPortalLive'))),
    );
    await waitFor(() =>
      expect(within(rowOf('Cedar Foods')).getByText(label('Clients.statusInvitePending'))),
    );
    // Nile's only invitation has expired, so nothing is pending and nobody is in the portal.
    expect(within(rowOf('Nile Robotics')).getByText(label('Clients.statusNotShared'))).toBeTruthy();
    expect(within(rowOf('Meridian Press')).getByText(label('Clients.statusArchived'))).toBeTruthy();
  });

  it('creates a new company, invites into it with its id, then shares the chosen project', async () => {
    const calls = mount();

    fireEvent.click(screen.getByRole('button', { name: label('Clients.inviteClient') }));
    const dialog = await screen.findByRole('dialog', { name: label('Clients.dialogTitle') });
    fireEvent.change(within(dialog).getByLabelText(label('Clients.emailLabel'), { exact: false }), {
      target: { value: 'sara@lotus.example' },
    });
    fireEvent.change(within(dialog).getByLabelText(label('Clients.orgLabel'), { exact: false }), {
      target: { value: 'Lotus Labs' },
    });
    fireEvent.click(within(dialog).getByLabelText(label('Clients.roleAdminOption')));
    const projects = within(dialog).getByLabelText(label('Clients.projectsLabel'));
    await within(dialog).findByRole('option', { name: 'Website relaunch' });
    fireEvent.change(projects, { target: { value: 'p-web' } });
    fireEvent.click(within(dialog).getByRole('button', { name: label('Clients.send') }));

    await screen.findByDisplayValue(/\/invitations\/tok-1$/);
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.path)).toEqual([
      '/client-organizations',
      '/invitations',
      '/projects/p-web/clients',
    ]);
    expect(posts[0]!.body).toEqual({ name: 'Lotus Labs' });
    expect(posts[1]!.body).toEqual({
      email: 'sara@lotus.example',
      role: 'client_admin',
      clientOrganizationId: 'co-new',
    });
    expect(posts[2]!.body).toEqual({ clientOrganizationId: 'co-new' });
  });

  it('resends a pending invitation and offers Send again for an expired one', async () => {
    const calls = mount();

    const invitations = await screen.findByRole('list', {
      name: label('Clients.invitationsTitle'),
    });
    await within(invitations).findByText('nour@cedarfoods.com');
    const nour = within(invitations).getByText('nour@cedarfoods.com').closest('li')!;
    const ahmed = within(invitations).getByText('ahmed@nilerobotics.io').closest('li')!;
    expect(within(ahmed).getByRole('button', { name: label('Clients.sendAgain') })).toBeTruthy();

    fireEvent.click(within(nour).getByRole('button', { name: label('Clients.resend') }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'POST' && call.path === '/invitations/inv-nour/reissues',
        ),
      ).toBe(true),
    );
    // 2026-10-31 live test: a resend used to show nothing at all. It now confirms on screen and
    // the row's button reads "Sent ✓" (Figma 446:37206).
    expect(await screen.findByText(label('Clients.resentTitle'))).toBeTruthy();
    const after = await screen.findByRole('list', { name: label('Clients.invitationsTitle') });
    const nourAfter = within(after).getByText('nour@cedarfoods.com').closest('li')!;
    expect(
      (
        within(nourAfter).getByRole('button', {
          name: label('Clients.resentButton'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('opens each client company on its own page', async () => {
    mount();
    const organizations = await screen.findByRole('list', {
      name: label('Clients.organizationsTitle'),
    });
    const link = within(organizations).getByText('Atlas Hospitality').closest('a')!;
    expect(link.getAttribute('href')).toBe('/northstar/clients/co-atlas');
  });

  it('shows the invitations card alone on the Invitations tab', async () => {
    mount();
    await screen.findByRole('list', { name: label('Clients.organizationsTitle') });
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(label('Clients.tabInvitations')) }),
    );
    expect(document.querySelector('.cl-screen')!.getAttribute('data-view')).toBe('invitations');
  });

  it('draws a tab count only once its list has loaded, never a premature 0', async () => {
    mount();
    const tab = screen.getByRole('button', {
      name: new RegExp(label('Clients.tabOrganizations')),
    });
    expect(tab.querySelector('.cl-count')).toBeNull();
    await screen.findByRole('list', { name: label('Clients.organizationsTitle') });
    await waitFor(() => expect(tab.querySelector('.cl-count')?.textContent).toBe('4'));
  });

  it('sends the personal note with the invitation', async () => {
    const calls = mount();
    await screen.findByRole('list', { name: label('Clients.organizationsTitle') });
    fireEvent.click(screen.getByRole('button', { name: label('Clients.inviteClient') }));
    const dialog = await screen.findByRole('dialog', { name: label('Clients.dialogTitle') });
    fireEvent.change(within(dialog).getByLabelText(label('Clients.emailLabel'), { exact: false }), {
      target: { value: 'sara@atlas.example' },
    });
    fireEvent.change(within(dialog).getByLabelText(label('Clients.orgLabel'), { exact: false }), {
      target: { value: 'Atlas Hospitality' },
    });
    const note = within(dialog).getByLabelText(label('Clients.noteLabel'), {
      exact: false,
    }) as HTMLInputElement;
    expect(note.disabled).toBe(false);
    fireEvent.change(note, { target: { value: 'Welcome aboard' } });
    fireEvent.click(within(dialog).getByRole('button', { name: label('Clients.send') }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path === '/invitations')).toBe(
        true,
      ),
    );
    const post = calls.find((call) => call.method === 'POST' && call.path === '/invitations')!;
    expect(post.body).toEqual({
      email: 'sara@atlas.example',
      role: 'client_reviewer',
      clientOrganizationId: 'co-atlas',
      note: 'Welcome aboard',
    });
    expect(screen.queryByText('Personal notes are coming soon.')).toBeNull();
  });
});
