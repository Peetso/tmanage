import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlatformPeopleScreen } from '../src/components/platform/PlatformAdminScreens';
import { ApiClient } from '../src/lib/api/client';

/** P2 / t1-d: the operator's "Reset <name>'s password" dialog on the People screen. */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));

const PERSON = {
  id: 'u1',
  email: 'salma@atlas.example',
  displayName: 'Salma Riad',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00Z',
  lastSignInAt: null,
  mfaEnabled: true,
  companies: [],
};

const ME = {
  email: 'op@tmanage.example',
  displayName: 'Op',
  mfaEnabled: true,
  stepUpExpiresAt: '2099-01-01T00:00:00Z',
  stepUpMinutes: 15,
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
      <PlatformPeopleScreen client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('P2 operator password reset dialog', () => {
  it('sends the reset with the reason and shows the confirmation', async () => {
    const calls = mount((url) => {
      if (url.endsWith('/v1/platform/me')) return json(ME);
      if (url.includes('/password-reset')) return json({ status: 'sent' }, 202);
      return json({ people: [PERSON] });
    });
    await userEvent.type(await screen.findByLabelText(/^PlatformAdminScreens.emailLabel/), 'salma');
    await userEvent.click(screen.getByRole('button', { name: 'PlatformAdminScreens.search' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'PlatformAdminScreens.sendPasswordReset' }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('ResetDialog.titleSalma Riad');
    await userEvent.type(
      screen.getByLabelText(/^ResetDialog.reasonLabel/),
      'Locked out, ticket 42',
    );
    await userEvent.click(screen.getByRole('button', { name: 'ResetDialog.send' }));
    expect(await screen.findByText('ResetDialog.sentTitle')).toBeInTheDocument();
    const reset = calls.find((call) => call.url.includes('/people/u1/password-reset'));
    expect(reset?.body).toEqual({ reason: 'Locked out, ticket 42' });
  });

  it('offers no reset to someone the API does not list as an operator', async () => {
    mount(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    expect(await screen.findByText('PlatformAdminScreens.pageDoesNotExist')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'PlatformAdminScreens.sendPasswordReset' }),
    ).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
