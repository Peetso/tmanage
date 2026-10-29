import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PersonProfileScreen } from '../src/components/platform/people/PersonProfileScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * P2 / t1-d: the operator's password reset for one person. platform-admin v2 · PA-06 moved it
 * from the old People search to the person page header (B2 434:16180, "Send password reset").
 */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));

const USER = '0199aa00-0000-7000-8000-0000000000d1';

const PERSON = {
  id: USER,
  email: 'salma@atlas.example',
  displayName: 'Salma Riad',
  locale: 'en',
  timezone: 'UTC',
  emailVerified: true,
  mfaEnabled: true,
  status: 'active',
  disabledAt: null,
  disabledReason: null,
  disabledByEmail: null,
  twoStepRequired: false,
  liveSessions: 1,
  facts: {
    createdAt: '2026-01-01T00:00:00Z',
    emailVerifiedAt: '2026-01-01T00:00:00Z',
    lastSignInAt: null,
    lastSignInDevice: null,
    twoStepKind: 'totp',
    twoStepSetUpAt: '2026-01-02T00:00:00Z',
    recoveryCodesLeft: 8,
    passwordSetAt: null,
    personalAccessTokens: 0,
    aiAppGrants: 0,
  },
  companies: [],
  recentActions: [],
  recentAccess: [],
};

const ME = {
  email: 'op@tmanage.example',
  displayName: 'Op',
  mfaEnabled: true,
  stepUpExpiresAt: '2099-01-01T00:00:00Z',
  stepUpMinutes: 15,
  source: 'env',
  preset: 'super_admin',
  permissions: ['platform.people.view', 'platform.people.edit', 'platform.people.security'],
  supportSessions: [],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(route: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(route(url, init));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PersonProfileScreen client={client} userId={USER} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('P2 operator password reset dialog', () => {
  it('sends the reset with the reason and shows the confirmation', async () => {
    const calls = mount((url) => {
      if (url.endsWith('/v1/platform/me')) return json(ME);
      if (url.includes('/password-reset')) return json({ status: 'sent' }, 202);
      return json(PERSON);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'PlatformPeople.sendReset' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('PlatformPeople.resetTitle Salma Riad?');
    await userEvent.type(
      within(dialog).getByLabelText(/^PlatformShared.reasonRequired/),
      'Locked out, ticket 42',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'PlatformPeople.sendReset' }));
    expect(
      await screen.findByText('PlatformPeople.resetSent salma@atlas.example.'),
    ).toBeInTheDocument();
    const reset = calls.find((call) => call.url.includes(`/people/${USER}/password-reset`));
    expect(reset?.body).toEqual({ reason: 'Locked out, ticket 42' });
  });

  it('offers no reset to someone the API does not list as an operator', async () => {
    mount(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    expect(await screen.findByText('PlatformAdminScreens.pageDoesNotExist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PlatformPeople.sendReset' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
