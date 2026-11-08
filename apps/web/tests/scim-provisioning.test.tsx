import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ScimProvisioningCard } from '../src/components/admin/ScimProvisioningCard';
import type { ScimSettingsView } from '../src/lib/api/scim';

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
      const call = {
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
  const view = render(
    <QueryClientProvider client={query}>
      <ScimProvisioningCard api={client} organizationSlug="northstar" />
    </QueryClientProvider>,
  );
  return { calls, view };
}

const settings = (over: Partial<ScimSettingsView> = {}): ScimSettingsView => ({
  available: true,
  baseUrl: 'https://tmanage.peetrix.com/v1/scim/v2',
  keys: [],
  ...over,
});

describe('54-16 User provisioning (SCIM) card', () => {
  it('asks for company sign-in first when it is not set up', async () => {
    mount(() => ({ status: 200, body: settings({ available: false }) }));
    expect(await screen.findByText(/Set up company sign-in first/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
  });

  it('creates a key, shows its secret once, and lists it with a revoke button', async () => {
    let keys: ScimSettingsView['keys'] = [];
    const { calls } = mount((call) => {
      if (call.method === 'POST') {
        const key = {
          id: 'k1',
          name: 'Okta',
          prefix: 'tmanage_scim_abc123',
          createdAt: '2026-11-08T10:00:00.000Z',
          lastUsedAt: null,
        };
        keys = [key];
        return { status: 201, body: { key, secret: 'tmanage_scim_secretvalue' } };
      }
      return { status: 200, body: settings({ keys }) };
    });
    expect(await screen.findByText(/https:\/\/tmanage\.peetrix\.com\/v1\/scim\/v2/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Key name/u), { target: { value: 'Okta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect((await screen.findByTestId('scim-secret')).textContent).toBe('tmanage_scim_secretvalue');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke Okta' })).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')?.body).toBe(JSON.stringify({ name: 'Okta' }));
  });

  it('hides for anyone but the owner', async () => {
    const { calls, view } = mount(() => ({
      status: 403,
      body: { code: 'forbidden', message: 'no' },
    }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(view.container.querySelector('section')).toBeNull());
  });
});
