import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
});
