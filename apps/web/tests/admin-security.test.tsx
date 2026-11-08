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
 * answers the security read, and asserts the 2FA toggle renders with the loaded value and that the
 * trusted-network-ranges row links out to the dedicated IP allowlist screen (CQ-16, ADM-14 — the
 * ranges are edited in one place, not inline here), and that the page has no axe violation jsdom can
 * see (A11Y-01).
 */

function securityClient(): ApiClient {
  const body = { enforce2fa: true, ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] };
  // A16 — the sign-in policy card on the same screen reads its own endpoint.
  const signInPolicy = {
    allowedMethods: ['password', 'google', 'microsoft', 'sso'],
    requireTwoStepRoles: 'nobody',
    graceUntil: null,
    sessionMaxHours: 720,
    idleSignOutMinutes: 0,
    membersWithoutAlternative: 0,
    ownMethods: ['password'],
  };
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(String(input).includes('/sign-in-policy') ? signInPolicy : body),
          {
            // 54-14: the company sign-in card is the owner's; this viewer is refused, so it hides.
            status: String(input).includes('/security/sso') ? 403 : 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
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

    // The IP allowlist moved to its own screen (CQ-16); this row links out to it rather than
    // editing the ranges inline.
    expect(screen.getByRole('link', { name: 'Ranges' })).toHaveAttribute(
      'href',
      '/northstar-studio/admin/ip-allowlist',
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await expectNoAxeViolations(container);
  });
});
