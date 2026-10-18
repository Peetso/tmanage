import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { RoleEditScreen } from '../src/components/screens/RoleEditScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Custom role clone + edit (x195) — the Administration role-edit screen.
 *
 * The screen picks a role from the API's list and offers an edit form (name + capability picker) and a
 * clone form. This mounts it against a client that answers the roles read, and asserts the role appears in
 * the picker, the edit form is primed from it (its name in the name field, one of its capabilities
 * checked), a clone name field is offered, and the page has no axe violation jsdom can see (A11Y-01).
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

describe('RoleEditScreen — Administration role clone + edit (x195)', () => {
  it('picks a role, primes the edit form from it, offers a clone name, and is axe-clean', async () => {
    const { container } = render(
      withQuery(
        <RoleEditScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={rolesClient()}
        />,
      ),
    );

    // The role list (ADM-03's left column) marks the chosen role and primes the edit form.
    expect(
      await screen.findByRole('button', { name: 'Coordinator', pressed: true }),
    ).toBeInTheDocument();
    const nameField = await screen.findByLabelText('Role name');
    expect(nameField).toHaveValue('Coordinator');
    // A capability the role holds is checked; the fixed allowlist is offered.
    expect(screen.getByLabelText('work.read')).toBeChecked();
    // The clone form offers a new-name field.
    expect(screen.getByLabelText('New role name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clone role' })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });
});
