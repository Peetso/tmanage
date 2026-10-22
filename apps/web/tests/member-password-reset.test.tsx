import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PersonProfileScreen } from '../src/components/screens/PersonProfileScreen';
import { ApiClient } from '../src/lib/api/client';

/** Q4 / t1-d: the org admin's "Reset <name>'s password" dialog on a person's profile. */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));
vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const PROFILE = {
  membershipId: 'm1',
  userId: 'u1',
  displayName: 'Salma Riad',
  role: 'member',
  status: 'active',
  projects: [],
  openWorkCount: 0,
  computedAt: '2026-10-22T00:00:00Z',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(reset: () => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(url.includes('/password-reset') ? reset() : json(PROFILE));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PersonProfileScreen
        organizationSlug="atlas"
        organizationName="Atlas"
        membershipId="m1"
        client={client}
      />
    </QueryClientProvider>,
  );
  return calls;
}

async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'ResetMemberPassword.open' }));
  return screen.getByRole('dialog');
}

describe('Q4 member password reset dialog', () => {
  it('opens from the profile hero with the email box checked and fixed', async () => {
    mount(() => json({ status: 'sent' }, 202));
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('ResetMemberPassword.title');
    const email = screen.getByRole('checkbox', { name: 'ResetMemberPassword.emailLink' });
    expect(email).toBeChecked();
    expect(email).toBeDisabled();
  });

  it('refuses to send without a reason of five characters', async () => {
    const calls = mount(() => json({ status: 'sent' }, 202));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/^ResetMemberPassword.reasonLabel/), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'ResetMemberPassword.send' }));
    expect(screen.getByText('ResetMemberPassword.reasonError')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/password-reset'))).toBe(false);
  });

  it('POSTs the reason to the member route and shows the success state', async () => {
    const calls = mount(() => json({ status: 'sent' }, 202));
    await openDialog();
    await userEvent.type(
      screen.getByLabelText(/^ResetMemberPassword.reasonLabel/),
      'Locked out after a phone change',
    );
    await userEvent.click(screen.getByRole('button', { name: 'ResetMemberPassword.send' }));
    expect(await screen.findByText('ResetMemberPassword.sentTitle')).toBeInTheDocument();
    const reset = calls.find((call) => call.url.includes('/password-reset'));
    expect(reset?.url).toBe(
      'https://api.example.test/v1/organizations/atlas/members/m1/password-reset',
    );
    expect(reset?.method).toBe('POST');
    expect(reset?.body).toEqual({ reason: 'Locked out after a phone change' });
  });

  it('renders a 403 from the API as not allowed', async () => {
    mount(() => json({ error: { code: 'forbidden', message: 'Forbidden' } }, 403));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/^ResetMemberPassword.reasonLabel/), 'Ticket 42');
    await userEvent.click(screen.getByRole('button', { name: 'ResetMemberPassword.send' }));
    expect(await screen.findByText('ResetMemberPassword.notAllowed')).toBeInTheDocument();
  });
});
