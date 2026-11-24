import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeopleListScreen } from '../src/components/platform/people/PeopleListScreen';
import { PersonProfileScreen } from '../src/components/platform/people/PersonProfileScreen';
import { PersonSecurityScreen } from '../src/components/platform/people/PersonSecurityScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * platform-admin v2 · PA-06 — People B1–B3 (frames 434:14534, 434:14921, 434:16180, 435:16133):
 * the list with a muted disabled row, the empty state, a taken email (409) on the profile, and
 * the two-step reset that needs a reason and can also sign the person out.
 */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));

const USER = '0199aa00-0000-7000-8000-0000000000d1';

const ME = {
  email: 'peter@peetrix.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpExpiresAt: '2099-01-01T00:00:00Z',
  stepUpMinutes: 15,
  source: 'env',
  preset: 'super_admin',
  permissions: ['platform.people.view', 'platform.people.edit', 'platform.people.security'],
  supportSessions: [],
};

const ROW = {
  id: USER,
  email: 'maya@northstar.studio',
  displayName: 'Maya Hassan',
  emailVerified: true,
  createdAt: '2026-03-01T00:00:00Z',
  lastSignInAt: null,
  mfaEnabled: true,
  locale: 'en',
  status: 'active',
  disabledAt: null,
  disabledReason: null,
  disabledByEmail: null,
  liveSessions: 2,
  companies: [
    {
      id: 'o1',
      name: 'Atlas Dental',
      slug: 'atlas',
      audience: 'internal',
      role: 'owner',
      status: 'active',
    },
    {
      id: 'o2',
      name: 'Northstar',
      slug: 'northstar',
      audience: 'client',
      role: 'client_member',
      status: 'active',
    },
  ],
};

const PERSON = {
  ...ROW,
  timezone: 'Africa/Cairo',
  twoStepRequired: false,
  facts: {
    createdAt: '2026-03-01T00:00:00Z',
    emailVerifiedAt: '2026-03-01T00:00:00Z',
    lastSignInAt: null,
    lastSignInDevice: null,
    twoStepKind: 'totp',
    twoStepSetUpAt: '2026-03-03T00:00:00Z',
    recoveryCodesLeft: 8,
    passwordSetAt: '2026-08-12T00:00:00Z',
    personalAccessTokens: 1,
    aiAppGrants: 1,
  },
  recentActions: [],
  recentAccess: [],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(route: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/v1/platform/me')) return Promise.resolve(json(ME));
      if (url.includes('/v1/platform/companies')) return Promise.resolve(json({ companies: [] }));
      return Promise.resolve(route(url, init));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  return { api, calls };
}

function mount(node: React.ReactNode) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  );
}

describe('B1 People list', () => {
  it('lists people with org chips and mutes a disabled row', async () => {
    const disabled = {
      ...ROW,
      id: '0199aa00-0000-7000-8000-0000000000d2',
      displayName: 'Omar Said',
      status: 'disabled',
      disabledAt: '2026-10-21T10:00:00Z',
      disabledByEmail: 'peter@peetrix.com',
      disabledReason: 'Left the company',
      companies: [],
    };
    const { api, calls } = client(() =>
      json({ people: [ROW, disabled], total: 2, nextCursor: null }),
    );
    mount(<PeopleListScreen client={api} />);
    expect(await screen.findByText('Maya Hassan')).toBeInTheDocument();
    expect(screen.getByText('Atlas Dental')).toBeInTheDocument();
    expect(screen.getByText(/Northstar · PlatformPeople.client/)).toBeInTheDocument();
    const omar = screen.getByText('Omar Said').closest('tr');
    expect(omar).toHaveAttribute('data-muted', 'true');
    // The drawn defaults: active, signed in during the last 30 days.
    const list = calls.find((call) => call.url.includes('/v1/platform/people?'));
    expect(list?.url).toContain('status=active');
    expect(list?.url).toContain('signInFrom=');
  });

  it('shows the empty state for a search with no match, and Browse all clears every filter', async () => {
    const { api, calls } = client(() => json({ people: [], total: 0, nextCursor: null }));
    mount(<PeopleListScreen client={api} />);
    await userEvent.type(
      await screen.findByLabelText('PlatformPeople.searchLabel'),
      'zeyad@{Enter}',
    );
    expect(await screen.findByText('PlatformPeople.emptyTitleFor “zeyad@”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'PlatformPeople.browseAllPeople' }));
    const last = calls.filter((call) => call.url.includes('/v1/platform/people')).at(-1);
    expect(last?.url).toBe('https://api.example.test/v1/platform/people?status=any');
  });

  it('Export CSV is present but disabled until Data exports (PA-09)', async () => {
    const { api } = client(() => json({ people: [ROW], total: 1, nextCursor: null }));
    mount(<PeopleListScreen client={api} />);
    const exportButton = await screen.findByRole('button', { name: 'PlatformPeople.exportCsv' });
    expect(exportButton).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('B2 Profile', () => {
  it('a taken email shows the 409 field error', async () => {
    const { api, calls } = client((url, init) => {
      if (init?.method === 'PATCH') {
        return json(
          {
            error: { code: 'conflict', message: 'That email already belongs to another account.' },
          },
          409,
        );
      }
      if (url.includes(`/people/${USER}`)) return json(PERSON);
      return json({});
    });
    mount(<PersonProfileScreen client={api} userId={USER} />);
    const email = await screen.findByLabelText('PlatformPeople.email');
    await userEvent.clear(email);
    await userEvent.type(email, 'sara@northstar.studio');
    expect(screen.getByText(/PlatformPeople.emailWarning1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'PlatformPeople.saveChanges' }));
    expect(await screen.findByText('PlatformPeople.emailTaken')).toBeInTheDocument();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ email: 'sara@northstar.studio' });
  });
});

describe('B3 Security', () => {
  it('reset two-step needs a reason, then sends it with "also sign out"', async () => {
    const { api, calls } = client((url) => {
      if (url.includes('/sessions')) return json({ sessions: [], live: 0, endedRecently: 0 });
      if (url.includes('/access')) return json({ events: [], stepUps: [] });
      if (url.includes('/two-step/reset')) return json({ person: PERSON, sessionsEnded: 2 });
      return json(PERSON);
    });
    mount(<PersonSecurityScreen client={api} userId={USER} />);
    expect(await screen.findByText('Maya PlatformPeople.noSessionsTitle')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'PlatformPeople.resetTwoStep' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'PlatformPeople.resetTwoStep' }),
    );
    expect(within(dialog).getByText('PlatformPeople.reasonMissing')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/two-step/reset'))).toBe(false);
    await userEvent.type(
      within(dialog).getByLabelText(/^PlatformPeople.reasonRequiredLabel/),
      'Lost phone, ticket 77',
    );
    await userEvent.click(within(dialog).getByLabelText('PlatformPeople.alsoSignOut'));
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'PlatformPeople.resetTwoStep' }),
    );
    await screen.findByText('PlatformPeople.twoStepTitle');
    const reset = calls.find((call) => call.url.includes('/two-step/reset'));
    expect(reset?.body).toEqual({ reason: 'Lost phone, ticket 77', signOut: true });
  });
});
