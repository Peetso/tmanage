import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { OrgSettingsScreen } from '../src/components/screens/OrgSettingsScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Organization settings / policy (x153) — the Administration settings screen.
 *
 * The screen is a faithful reader of the API's fixed-key allowlist: this mounts it against a client
 * that answers the settings read, and asserts every allowlisted key renders a labelled field with its
 * value and a Save control, and that the page has no axe violation jsdom can see (A11Y-01).
 */

function settingsClient(): ApiClient {
  const body = {
    settings: [
      { key: 'default_timezone', value: 'Europe/London' },
      { key: 'require_reauth_minutes', value: '0' },
      { key: 'client_visible_project_default', value: 'false' },
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

function withQuery(children: ReactNode, role = 'owner') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The session's organization list, which tells the screen the caller's role (ACT-13).
  client.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar-studio', name: 'Harbour Studio', audience: 'internal', role }],
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('OrgSettingsScreen — Administration settings (x153)', () => {
  it('renders a labelled field for each allowlisted setting, with its value', async () => {
    const { container } = render(
      withQuery(
        <OrgSettingsScreen
          organizationSlug="northstar-studio"
          organizationName="Harbour Studio"
          client={settingsClient()}
        />,
      ),
    );

    const timezone = await screen.findByLabelText('Default timezone');
    expect(timezone).toHaveValue('Europe/London');
    expect(screen.getByLabelText('Re-authentication window (minutes)')).toHaveValue('0');
    expect(screen.getByLabelText('New projects client-visible by default')).toHaveValue('false');

    expect(screen.getAllByRole('button', { name: 'Save' }).length).toBe(3);

    await expectNoAxeViolations(container);
  });

  it('sends a member to Preferences without reading the settings (ACT-13)', async () => {
    let reads = 0;
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() => {
        reads += 1;
        return Promise.resolve(new Response('{}', { status: 403 }));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'correlation-fixed',
    });
    const { container } = render(
      withQuery(
        <OrgSettingsScreen
          organizationSlug="northstar-studio"
          organizationName="Harbour Studio"
          client={client}
        />,
        'member',
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
    expect(reads).toBe(0);
  });
});
