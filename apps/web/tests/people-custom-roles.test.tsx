import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { expectNoAxeViolations } from './axe';

/**
 * F1 — give a member a custom role (Figma 389:4749: Change role and Invite, with custom roles and
 * with none yet). The fake fetch answers by method and path and records every write, so each case
 * proves what the dialog sent: a custom role goes as `customRoleId`, an invitation carries the
 * custom role id as its role, and with no custom roles the card links to Control > Roles.
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
    projectRole: role === 'manager' || role === 'member',
    assignable: true,
  })),
};

const LEAD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FINANCE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const CUSTOM = {
  roles: [
    {
      id: LEAD,
      name: 'Project lead',
      capabilities: ['project.manage', 'work.read', 'approval.read', 'file.upload'],
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: FINANCE,
      name: 'Finance reviewer',
      capabilities: ['approval.read'],
      createdAt: '2026-10-02T00:00:00.000Z',
    },
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

function mount(options: { people: readonly object[]; custom: object }) {
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
    if (url.pathname.endsWith('/admin/invitations')) return reply({ invitations: [] });
    if (url.pathname.endsWith('/admin/roles/built-in')) return reply(BUILT_IN);
    if (url.pathname.endsWith('/admin/roles')) return reply(options.custom);
    if (url.pathname.endsWith('/projects')) return reply({ projects: [] });
    if (url.pathname.endsWith('/role') && method === 'PATCH') {
      return reply({
        userId: 'u-sara',
        membershipId: 'm-u-sara',
        previousRole: 'member',
        role: LEAD,
        status: 'active',
        version: 4,
        changed: true,
      });
    }
    if (url.pathname.endsWith('/invitations') && method === 'POST') {
      return reply(
        {
          invitation: { id: 'i9', email: 'omar@northstar.studio', role: LEAD },
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
    [{ id: 'o1', slug: 'northstar', name: 'Northstar Studio', role: 'owner' }],
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

describe('Custom roles in Change role and Invite (F1)', () => {
  it('gives Sara a custom role: "Custom roles" group, named confirm, sent as customRoleId', async () => {
    const { sent, container } = mount({ people: [MAYA, SARA], custom: CUSTOM });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Role of Sara Ali: Member. Change role' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change role' });
    expect(await within(dialog).findByText('Built-in roles', { selector: 'p' })).toBeTruthy();
    const lead = await within(dialog).findByRole('radio', { name: /Project lead/ });
    expect(within(dialog).getByText('Custom roles', { selector: 'p' })).toBeTruthy();
    // The card's second line names its first rights, as Control > Roles lists them.
    expect(
      within(dialog).getByText('Manage project settings · See work items · See approvals …'),
    ).toBeTruthy();

    fireEvent.click(lead);
    expect(
      within(dialog).getByText('Sara will get a notice. They get the rights set for Project lead.'),
    ).toBeTruthy();
    await expectNoAxeViolations(container);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change to Project lead' }));

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/v1/organizations/northstar/members/u-sara/role',
        body: { customRoleId: LEAD, version: 3 },
      }),
    );
  });

  it('names a member who already holds a custom role, and checks that card', async () => {
    mount({ people: [MAYA, person('u-sara', 'Sara Ali', LEAD, { version: 3 })], custom: CUSTOM });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Role of Sara Ali: Project lead. Change role' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change role' });
    expect(within(dialog).getByText('Current role: Project lead')).toBeTruthy();
    const lead = await within(dialog).findByRole('radio', { name: /Project lead/ });
    expect((lead as HTMLInputElement).checked).toBe(true);
    const confirm = within(dialog).getByRole('button', { name: 'Change to Project lead' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('with no custom roles yet, links to Control > Roles instead', async () => {
    mount({ people: [MAYA, SARA], custom: { roles: [] } });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Role of Sara Ali: Member. Change role' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change role' });
    expect(await within(dialog).findByText('No custom roles yet')).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Create a custom role' }).getAttribute('href'),
    ).toBe('/northstar/admin/roles');
  });

  it('invites with a custom role: the invitation carries the role id', async () => {
    const { sent } = mount({ people: [MAYA, SARA], custom: CUSTOM });

    fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a team member' });
    fireEvent.change(within(dialog).getByLabelText(/Email/), {
      target: { value: 'omar@northstar.studio' },
    });
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Finance reviewer/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/v1/organizations/northstar/invitations',
        body: expect.objectContaining({ email: 'omar@northstar.studio', role: FINANCE }),
      }),
    );
  });
});
