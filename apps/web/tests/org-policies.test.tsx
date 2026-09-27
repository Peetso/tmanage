import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminPoliciesScreen } from '../src/components/screens/AdminPoliciesScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Organization access policies (x174) — the Administration access-policy screen.
 *
 * The screen is a faithful reader of the API's fixed-key allowlist: this mounts it against a client that
 * answers the policy read, and asserts each typed policy renders a labelled control with its value, and
 * that the page has no axe violation jsdom can see (A11Y-01).
 */

function policyClient(): ApiClient {
  const body = {
    policy: {
      session_max_hours: 12,
      invite_domain_allowlist: ['example.com', 'partner.test'],
      guest_access_enabled: true,
    },
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

describe('AdminPoliciesScreen — Administration access policies (x174)', () => {
  it('renders a labelled control for each access policy, with its value', async () => {
    const { container } = render(
      withQuery(
        <AdminPoliciesScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={policyClient()}
        />,
      ),
    );

    const sessionHours = await screen.findByLabelText('Session lifetime (hours)');
    expect(sessionHours).toHaveValue(12);
    expect(screen.getByLabelText('Invite domain allowlist')).toHaveValue(
      'example.com, partner.test',
    );
    expect(screen.getByLabelText('Allow guest access')).toBeChecked();

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });
});
