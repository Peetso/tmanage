import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminSecurityScreen } from '../src/components/screens/AdminSecurityScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Organization security settings (x176) — the Administration security screen.
 *
 * The screen is a faithful reader of the API's stored posture: this mounts it against a client that
 * answers the security read, and asserts the 2FA toggle and the IP allowlist editor render with the
 * loaded values, and that the page has no axe violation jsdom can see (A11Y-01).
 */

function securityClient(): ApiClient {
  const body = { enforce2fa: true, ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] };
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

describe('AdminSecurityScreen — Administration security (x176)', () => {
  it('renders the 2FA toggle and IP allowlist editor with the loaded posture, axe-clean', async () => {
    const { container } = render(
      withQuery(
        <AdminSecurityScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={securityClient()}
        />,
      ),
    );

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    });
    expect(toggle).toBeChecked();

    const allowlist = screen.getByLabelText('IP allowlist');
    expect(allowlist).toHaveValue('203.0.113.0/24, 2001:db8::/32');

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await expectNoAxeViolations(container);
  });
});
