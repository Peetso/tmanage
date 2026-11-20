import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { SignInSecurityScreen } from '../src/components/screens/SignInSecurityScreen';
import { fromBase64Url, toBase64Url } from '../src/lib/api/passkeys';

interface Call {
  method: string;
  url: string;
  reauth: string | null;
  body: string | null;
}

function mount(route: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        reauth: headers.get('x-reauth-token'),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const { status, body } = route(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SignInSecurityScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
      />
    </QueryClientProvider>,
  );
  return calls;
}

const score = {
  score: 80,
  checks: [
    { id: 'two_step', passed: true, points: 30, fix: 'two-step' },
    { id: 'passkey', passed: true, points: 30, fix: 'sign-in-security' },
    { id: 'recovery_codes', passed: true, points: 20, fix: 'two-step' },
    { id: 'recent_password', passed: false, points: 20, fix: 'password' },
  ],
};
const devices = [
  {
    id: 's1',
    current: true,
    browser: 'Chrome',
    os: 'macOS',
    deviceType: 'desktop',
    country: 'Saudi Arabia',
    countryCode: 'SA',
    lastSeenAt: '2026-11-08T10:00:00Z',
  },
  {
    id: 's2',
    current: false,
    browser: 'Safari',
    os: 'iOS',
    deviceType: 'mobile',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    lastSeenAt: '2026-11-08T08:00:00Z',
  },
];

/** STEPUPFIX: the server's "does reauth want an authenticator code" flag, per case. */
function factorsView(reauthNeedsAuthenticatorCode: boolean) {
  return {
    factors: [],
    recoveryCodesRemaining: 10,
    email: { address: 'o***@northstar.studio', verified: true },
    reauthNeedsAuthenticatorCode,
  };
}

function routes(call: Call, needsCode = true) {
  if (call.url.endsWith('/v1/auth/factors')) return { status: 200, body: factorsView(needsCode) };
  if (call.url.endsWith('/security-score')) return { status: 200, body: score };
  if (call.url.endsWith('/passkeys'))
    return {
      status: 200,
      body: {
        passkeys: [
          {
            id: 'p1',
            name: 'MacBook Pro',
            backedUp: true,
            createdAt: '2026-11-03T00:00:00Z',
            lastUsedAt: null,
          },
        ],
      },
    };
  if (call.url.endsWith('/security-devices')) return { status: 200, body: { devices } };
  if (call.url.endsWith('/v1/auth/reauth'))
    return { status: 200, body: { reauthToken: 'proof-1' } };
  if (call.method === 'DELETE' && call.reauth === null) {
    return {
      status: 403,
      body: {
        error: {
          code: 'reauthentication_required',
          message: 'Confirm',
          correlationId: 'c',
          details: [],
        },
      },
    };
  }
  return { status: 204 };
}

describe('SignInSecurityScreen (56-22)', () => {
  it('shows the score with a fix link, the passkeys and the devices (country only, this device marked)', async () => {
    mount(routes);
    expect(await screen.findByText('80')).toBeTruthy();
    // ACCOUNT item 4: the signed-in change on the profile, not account recovery.
    expect(screen.getByRole('link', { name: 'Change password' }).getAttribute('href')).toBe(
      '/northstar/preferences#tm-profile-security',
    );
    expect(await screen.findByText('MacBook Pro')).toBeTruthy();
    expect(await screen.findByText('This device')).toBeTruthy();
    expect(screen.getByText(/United Arab Emirates/u)).toBeTruthy();
  });

  it('asks for the password, then retries "sign out" with the proof', async () => {
    const calls = mount(routes);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'DELETE' && c.url.endsWith('/v1/sessions/s2') && c.reauth === 'proof-1',
        ),
      ).toBe(true),
    );
  });

  it('STEPUPFIX: two-step by e-mail codes confirms with the password alone, no code field', async () => {
    const calls = mount((call) => routes(call, false));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'DELETE' && c.url.endsWith('/v1/sessions/s2') && c.reauth === 'proof-1',
        ),
      ).toBe(true),
    );
    const reauth = calls.find((c) => c.url.endsWith('/v1/auth/reauth'));
    expect(JSON.parse(reauth?.body ?? '{}')).toEqual({ password: 'pw' });
  });

  it('DC-2: an unreadable step-up decision is shown as unknown and never sends a password-only proof', async () => {
    const calls = mount((call) =>
      call.url.endsWith('/v1/auth/factors') ? { status: 503 } : routes(call),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    expect(
      await screen.findByText('We cannot reach TManage to check what this change needs.'),
    ).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(calls.some((c) => c.url.endsWith('/v1/auth/reauth'))).toBe(false);
  });

  it('round-trips base64url', () => {
    expect(toBase64Url(fromBase64Url('AQID_-8'))).toBe('AQID_-8');
  });
});
