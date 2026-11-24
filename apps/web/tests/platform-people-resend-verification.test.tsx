import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeopleListScreen } from '../src/components/platform/people/PeopleListScreen';
import { PersonProfileScreen } from '../src/components/platform/people/PersonProfileScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * RESENDVERIFY (2026-11-24). Owner: "I want to send a verification email to the old unverified
 * people." The People list offers the bulk send with the count in the button and the dialog; the
 * person page offers "Resend verification e-mail" only while the address is unconfirmed.
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
  emailVerified: false,
  createdAt: '2026-03-01T00:00:00Z',
  lastSignInAt: null,
  mfaEnabled: false,
  locale: 'en',
  status: 'active',
  disabledAt: null,
  disabledReason: null,
  disabledByEmail: null,
  liveSessions: 0,
  companies: [],
};

const PERSON = {
  ...ROW,
  timezone: 'Africa/Cairo',
  twoStepRequired: false,
  facts: {
    createdAt: '2026-03-01T00:00:00Z',
    emailVerifiedAt: null,
    lastSignInAt: null,
    lastSignInDevice: null,
    twoStepKind: null,
    twoStepSetUpAt: null,
    recoveryCodesLeft: 0,
    passwordSetAt: '2026-03-01T00:00:00Z',
    personalAccessTokens: 0,
    aiAppGrants: 0,
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

function client(route: (url: string, init?: RequestInit) => Response, me: unknown = ME) {
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
      if (url.endsWith('/v1/platform/me')) return Promise.resolve(json(me));
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

const BULK = '/v1/platform/people/email-confirmations';

describe('People list: send the verification e-mail to everyone unverified', () => {
  it('states the count, confirms, sends once and reports what happened', async () => {
    const { api, calls } = client((url, init) => {
      if (url.endsWith(BULK) && init?.method === 'POST') {
        return json({ sent: 3, alreadyConfirmed: 0, notSent: 1, batchCap: 100, notReached: 0 });
      }
      if (url.endsWith(BULK)) return json({ unverified: 4, batchCap: 100 });
      return json({ people: [ROW], total: 1, nextCursor: null });
    });
    mount(<PeopleListScreen client={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'PlatformPeople.verifyAllAction (4)' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('PlatformPeople.verifyAllTitle 4 PlatformPeople.peopleWord?'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'PlatformPeople.verifyAllConfirm' }),
    );
    expect(
      await screen.findByText(
        'PlatformPeople.verifyAllDone 3 PlatformPeople.peopleWord. PlatformPeople.verifyAllNotSent 1.',
      ),
    ).toBeInTheDocument();
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => [call.url, call.body])).toEqual([
      [`https://api.example.test${BULK}`, {}],
    ]);
  });

  it('says the cap in the dialog when there are more people than one send reaches', async () => {
    const { api } = client((url) => {
      if (url.endsWith(BULK)) return json({ unverified: 140, batchCap: 100 });
      return json({ people: [ROW], total: 1, nextCursor: null });
    });
    mount(<PeopleListScreen client={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'PlatformPeople.verifyAllAction (140)' }),
    );
    expect(
      within(screen.getByRole('dialog')).getByText(
        'PlatformPeople.verifyAllBody PlatformPeople.verifyAllCap1 100 PlatformPeople.verifyAllCap2',
      ),
    ).toBeInTheDocument();
  });

  it('is not offered when nobody is unverified, or without the security permission', async () => {
    const none = client((url) => {
      if (url.endsWith(BULK)) return json({ unverified: 0, batchCap: 100 });
      return json({ people: [ROW], total: 1, nextCursor: null });
    });
    mount(<PeopleListScreen client={none.api} />);
    expect(await screen.findByText('Maya Hassan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PlatformPeople.verifyAllAction/ })).toBeNull();
  });

  it('does not even ask for the count without platform.people.security', async () => {
    const viewer = client(() => json({ people: [ROW], total: 1, nextCursor: null }), {
      ...ME,
      permissions: ['platform.people.view'],
    });
    mount(<PeopleListScreen client={viewer.api} />);
    expect(await screen.findByText('Maya Hassan')).toBeInTheDocument();
    expect(viewer.calls.some((call) => call.url.endsWith(BULK))).toBe(false);
  });
});

describe('Person page: resend the verification e-mail', () => {
  it('shows the action only while unverified, and sends the link for this person', async () => {
    const { api, calls } = client((url, init) => {
      if (url.endsWith(`/people/${USER}/email-confirmation`) && init?.method === 'POST') {
        return json({ status: 'sent' }, 202);
      }
      if (url.includes(`/people/${USER}`)) return json(PERSON);
      return json({});
    });
    mount(<PersonProfileScreen client={api} userId={USER} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'PlatformPeople.resendVerification' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'PlatformPeople.resendVerification' }),
    );
    expect(await screen.findByText('PlatformPeople.resendVerificationSent')).toBeInTheDocument();
    const post = calls.find((call) => call.method === 'POST');
    expect([post?.url, post?.body]).toEqual([
      `https://api.example.test/v1/platform/people/${USER}/email-confirmation`,
      {},
    ]);
  });

  it('is hidden for a confirmed address', async () => {
    const confirmed = client((url) =>
      url.includes(`/people/${USER}`) ? json({ ...PERSON, emailVerified: true }) : json({}),
    );
    mount(<PersonProfileScreen client={confirmed.api} userId={USER} />);
    expect(await screen.findByText('PlatformPeople.accountFacts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PlatformPeople.resendVerification' })).toBeNull();
  });

  it('is hidden for a disabled account', async () => {
    const disabled = client((url) =>
      url.includes(`/people/${USER}`)
        ? json({ ...PERSON, status: 'disabled', disabledAt: '2026-10-21T10:00:00Z' })
        : json({}),
    );
    mount(<PersonProfileScreen client={disabled.api} userId={USER} />);
    expect(await screen.findByText('PlatformPeople.accountFacts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PlatformPeople.resendVerification' })).toBeNull();
  });
});
