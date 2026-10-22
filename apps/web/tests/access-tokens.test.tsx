import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { SecurityScreen } from '../src/components/screens/SecurityScreen';
import { tokenStatus } from '../src/lib/api/personal-access-tokens';
import type { PersonalAccessTokenView } from '../src/lib/api/personal-access-tokens';

const NOW = new Date('2026-10-22T12:00:00.000Z');

function token(overrides: Partial<PersonalAccessTokenView> = {}): PersonalAccessTokenView {
  return {
    id: 't1',
    name: 'Claude desktop',
    tokenPrefix: 'tmanage_pat_ab12',
    lastUsedAt: '2026-10-22T08:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function mount(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const { status, body } = routes(call);
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
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <SecurityScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('SecurityScreen — Access tokens', () => {
  it('creates a token with a required expiry and shows the secret once', async () => {
    let tokens: PersonalAccessTokenView[] = [];
    const calls = mount((call) => {
      if (call.method === 'POST') {
        const created = token({ id: 'new', name: 'Laptop script', lastUsedAt: null });
        tokens = [created];
        return { status: 201, body: { ...created, token: 'tmanage_pat_secretvalue' } };
      }
      return { status: 200, body: { tokens } };
    });

    await screen.findByText('You have no tokens yet.');
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    const dialog = screen.getByRole('dialog', { name: 'New token' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('90 days').checked).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Laptop script' } });
    fireEvent.click(within(dialog).getByLabelText('30 days'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect((await screen.findByTestId('tm-token-secret')).textContent).toBe(
      'tmanage_pat_secretvalue',
    );
    const post = calls.find((call) => call.method === 'POST');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ name: 'Laptop script', expiresInDays: 30 });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByText('Laptop script');
    expect(screen.queryByText('tmanage_pat_secretvalue')).toBeNull();
  });

  it('revokes after confirming and removes the row', async () => {
    let tokens = [token()];
    const calls = mount((call) => {
      if (call.method === 'DELETE') {
        tokens = [{ ...tokens[0]!, revokedAt: NOW.toISOString() }];
        return { status: 204 };
      }
      return { status: 200, body: { tokens } };
    });

    await screen.findByText('Claude desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude desktop' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke this token?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryAllByTestId('tm-token-row')).toHaveLength(0));
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/t1'))).toBe(true);
  });

  it('reads each token as active, expiring within a week, or expired', () => {
    expect(tokenStatus(token(), NOW)).toBe('active');
    expect(tokenStatus(token({ expiresAt: '2026-10-27T00:00:00.000Z' }), NOW)).toBe('expiring');
    expect(tokenStatus(token({ expiresAt: '2026-09-01T00:00:00.000Z' }), NOW)).toBe('expired');
  });
});
