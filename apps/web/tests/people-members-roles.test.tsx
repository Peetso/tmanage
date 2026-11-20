import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { expectNoAxeViolations } from './axe';

/**
 * A1 — Members and roles (Figma 374:1985: r-people, r-change-role, r-last-owner, r-invite).
 *
 * The fake fetch answers by method and path, and records every write, so each case proves what
 * the screen actually sent: the role change carries the row's version, the last owner cannot be
 * demoted from the dialog, and an invitation carries its role, projects and note.
 */

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const BUILT_IN = {
  roles: [
    { role: 'owner', kind: 'internal', capabilities: [], projectRole: false, assignable: true },
    { role: 'org_admin', kind: 'internal', capabilities: [], projectRole: false, assignable: true },
    { role: 'manager', kind: 'internal', capabilities: [], projectRole: true, assignable: true },
    { role: 'member', kind: 'internal', capabilities: [], projectRole: true, assignable: true },
  ],
};

function person(userId: string, displayName: string, role: string, extra: object = {}) {
  return {
    userId,
    displayName,
    role,
    status: 'active',
    projectCount: 4,
    membershipId: `m-${userId}`,
    teams: [],
    openCommitments: 0,
    overdueCommitments: 0,
    declared: null,
    ...extra,
  };
}

function mount(options: { people: readonly object[]; myRole?: string }) {
  const sent: Sent[] = [];
  const routed: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (method !== 'GET') sent.push({ method, path: url.pathname, body });
    const reply = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.pathname.endsWith('/people')) return reply({ people: options.people, nextAfter: null });
    if (url.pathname.endsWith('/admin/invitations')) {
      return reply({
        invitations: [
          { id: 'i1', email: 'a@x.test', role: 'member', isExpired: false },
          { id: 'i2', email: 'b@x.test', role: 'member', isExpired: false },
          { id: 'i3', email: 'c@x.test', role: 'member', isExpired: true },
        ],
      });
    }
    if (url.pathname.endsWith('/admin/roles/built-in')) return reply(BUILT_IN);
    if (url.pathname.endsWith('/projects')) {
      return reply({
        projects: [
          { id: 'p-atlas', name: 'Atlas relaunch', archivedAt: null },
          { id: 'p-meridian', name: 'Meridian app', archivedAt: null },
        ],
      });
    }
    if (url.pathname.endsWith('/role') && method === 'PATCH') {
      return reply({
        userId: 'u-sara',
        membershipId: 'm-u-sara',
        previousRole: 'member',
        role: 'manager',
        status: 'active',
        version: 4,
        changed: true,
      });
    }
    if (url.pathname.endsWith('/invitations') && method === 'POST') {
      return reply(
        {
          invitation: { id: 'i9', email: 'omar@northstar.studio', role: 'manager' },
          token: 't',
          delivery: 'sent',
        },
        201,
      );
    }
    return reply({ connections: [], viewerName: 'Maya Hassan' });
  }) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar', name: 'Northstar Studio', role: options.myRole ?? 'owner' }],
  );
  const view = render(
    <QueryClientProvider client={queries}>
      <PeopleDirectoryScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
  return { ...view, sent };
}

const MAYA = person('u-maya', 'Maya Hassan', 'owner');
const SARA = person('u-sara', 'Sara Ali', 'member', { version: 3 });

describe('Members and roles (r-people)', () => {
  it('draws the roster table with role chips, counts and the owner footnote, accessibly', async () => {
    const { container } = mount({ people: [MAYA, SARA] });

    const table = await screen.findByRole('table', { name: 'People in this organization' });
    expect(within(table).getByText('Sara Ali')).toBeTruthy();
    expect(within(table).getAllByText('4 projects')).toHaveLength(2);
    expect(await screen.findByText('2 members · 2 invitations waiting')).toBeTruthy();
    // The frame's own header; the shell's (hidden by CSS in a browser) carries the same title.
    expect(
      screen.getAllByRole('heading', { level: 1, name: 'Members and roles' }),
    ).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Invite member' })).toBeTruthy();
    expect(screen.getByText("Only an owner can change another owner's role.")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Sara Ali' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Change role' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Send password reset link' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'View profile' }).getAttribute('href')).toBe(
      '/northstar/people/m-u-sara',
    );
    expect(
      within(menu)
        .getByRole('menuitem', { name: 'Remove from Northstar Studio' })
        .getAttribute('href'),
    ).toBe('/northstar/people/offboarding?member=u-sara');

    await expectNoAxeViolations(container);
  });

  it('shows the address and LAST ACTIVE the directory read projects (B2)', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    mount({
      people: [
        { ...MAYA, email: null, lastActiveAt: null, version: 1 },
        { ...SARA, email: 'sara@northstar.studio', lastActiveAt: threeDaysAgo },
      ],
    });

    const table = await screen.findByRole('table', { name: 'People in this organization' });
    const saraRow = within(table).getByText('Sara Ali').closest('tr');
    const mayaRow = within(table).getByText('Maya Hassan').closest('tr');
    expect(saraRow).not.toBeNull();
    expect(mayaRow).not.toBeNull();
    expect(within(saraRow as HTMLElement).getByText('sara@northstar.studio')).toBeTruthy();
    expect(within(saraRow as HTMLElement).getByText('3 days ago')).toBeTruthy();
    // A null address (a non-staff caller, or none on file) draws no second line; never-active is "—".
    expect((mayaRow as HTMLElement).textContent).not.toContain('@');
    expect(within(mayaRow as HTMLElement).getByText('—')).toBeTruthy();
  });

  it('changes a role with the row version (r-change-role)', async () => {
    const { sent } = mount({ people: [MAYA, SARA] });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Role of Sara Ali: Member. Change role' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change role' });
    expect(within(dialog).getByText('Current role: Member')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Change to Member' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(await within(dialog).findByRole('radio', { name: /Manager/ }));
    expect(
      within(dialog).getByText('Sara will get a notice. Managers can run projects and teams.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change to Manager' }));

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/v1/organizations/northstar/members/u-sara/role',
        body: { role: 'manager', version: 3 },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the only owner in place: red note and a disabled confirm (r-last-owner)', async () => {
    const { sent } = mount({ people: [MAYA, SARA] });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Role of Maya Hassan: Owner. Change role' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change role' });
    expect(within(dialog).getByText('Maya is the only owner')).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Admin/ }));

    const confirm = within(dialog).getByRole('button', { name: 'Change to Admin' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(sent).toHaveLength(0);
  });

  it('never offers an admin the owner seat', async () => {
    mount({ people: [MAYA, SARA], myRole: 'org_admin' });

    await screen.findByRole('table', { name: 'People in this organization' });
    expect(screen.queryByRole('button', { name: /Role of Maya Hassan/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Role of Sara Ali: Member. Change role' }),
    ).toBeTruthy();
  });

  it('QA-FIX-P S3: never offers an admin a reset or removal for the owner or another admin', async () => {
    const ADA = person('u-ada', 'Ada Admin', 'org_admin');
    mount({ people: [MAYA, ADA, SARA], myRole: 'org_admin' });

    await screen.findByRole('table', { name: 'People in this organization' });
    for (const name of ['Maya Hassan', 'Ada Admin']) {
      fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
      const menu = screen.getByRole('menu');
      expect(within(menu).queryByRole('menuitem', { name: 'Send password reset link' })).toBeNull();
      expect(within(menu).queryByRole('menuitem', { name: 'Change role' })).toBeNull();
      expect(within(menu).queryByRole('menuitem', { name: /Remove from/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Sara Ali' }));
    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Send password reset link' }),
    ).toBeTruthy();
  });

  it('invites with a role, projects and a note (r-invite)', async () => {
    const { sent } = mount({ people: [MAYA, SARA] });

    fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a team member' });
    fireEvent.change(within(dialog).getByLabelText(/Email/), {
      target: { value: 'omar@northstar.studio' },
    });
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Manager/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Add to projects/ }));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Atlas relaunch/ }));
    fireEvent.click(within(dialog).getByRole('option', { name: /Meridian app/ }));
    fireEvent.change(within(dialog).getByLabelText(/Personal note/), {
      target: { value: 'Welcome to the studio' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/v1/organizations/northstar/invitations',
        body: {
          email: 'omar@northstar.studio',
          role: 'manager',
          projectIds: ['p-atlas', 'p-meridian'],
          note: 'Welcome to the studio',
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
