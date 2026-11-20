import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminRolesScreen } from '../src/components/screens/AdminRolesScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Custom roles (x173) — the Administration roles screen.
 *
 * The screen is a faithful reader of the API's role list and a picker over the fixed capability
 * allowlist: this mounts it against a client that answers the roles read, and asserts the existing role
 * renders, the create form offers a name field and a capability picker, and the page has no axe
 * violation jsdom can see (A11Y-01).
 */

function rolesClient(): ApiClient {
  const body = {
    roles: [
      {
        id: 'role-1',
        name: 'Coordinator',
        capabilities: ['work.read', 'work.create'],
        createdAt: '2026-09-27T00:00:00.000Z',
      },
    ],
  };
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('AdminRolesScreen — Administration roles (x173)', () => {
  it('lists a custom role, offers a name field and a capability picker, and is axe-clean', async () => {
    const { container } = render(
      withQuery(
        <AdminRolesScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={rolesClient()}
        />,
      ),
    );

    expect(await screen.findByText('Coordinator')).toBeInTheDocument();
    expect(screen.getByLabelText('Role name')).toBeInTheDocument();
    // The picker offers the fixed allowlist — a representative capability is present as a checkbox.
    expect(screen.getByLabelText('See work items')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create role' })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  /** QA-FIX-P M4: a person without `org.manage` is never handed the form the API would refuse. */
  function seeded(role: string, children: ReactNode) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(
      ['shell', 'organizations'],
      [
        {
          id: 'org-1',
          slug: 'northstar-studio',
          name: 'Northstar Studio',
          audience: 'internal',
          role,
          clientOrganizationName: null,
        },
      ],
    );
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  it('M4: a Manager sees the no-access state, not the Create-role form', async () => {
    render(
      seeded(
        'manager',
        <AdminRolesScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={rolesClient()}
        />,
      ),
    );
    expect(await screen.findByText('You can’t open this page')).toBeInTheDocument();
    expect(screen.queryByLabelText('Role name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create role' })).toBeNull();
  });

  it('M4: a refused create shows the 403 message and moves focus to it', async () => {
    const user = userEvent.setup();
    const api = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? new Response(
                JSON.stringify({
                  error: {
                    code: 'forbidden',
                    message: 'You do not have permission to perform this action',
                    correlationId: 'c1',
                  },
                }),
                { status: 403, headers: { 'content-type': 'application/json' } },
              )
            : new Response(JSON.stringify({ roles: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      seeded(
        'owner',
        <AdminRolesScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={api}
        />,
      ),
    );
    await user.type(await screen.findByLabelText('Role name'), 'Night editor');
    await user.click(screen.getByLabelText('See work items'));
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    const message = await screen.findByText('You do not have permission to perform this action');
    await waitFor(() => expect(message.closest('[tabindex="-1"]')).toHaveFocus());
  });
});
