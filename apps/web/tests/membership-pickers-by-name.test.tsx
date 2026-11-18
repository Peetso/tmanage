import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BillingSeatsScreen } from '../src/components/screens/BillingSeatsScreen';
import { PolicySimulationScreen } from '../src/components/screens/PolicySimulationScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * CLEANUP P3 (dev text on screen): the two screens whose API takes a membership id — seats and
 * the policy simulator — offer people by name and never show the id, the rule id or a denial code.
 */

const PEOPLE = [
  { userId: 'u-ava', membershipId: 'm-ava', displayName: 'Ava Romero', role: 'owner' },
  { userId: 'u-liam', membershipId: 'm-liam', displayName: 'Liam Osei', role: 'manager' },
].map((person) => ({
  ...person,
  status: 'active',
  projectCount: 0,
  teams: [],
  openCommitments: 0,
  overdueCommitments: 0,
  declared: null,
  email: null,
  lastActiveAt: null,
  roleName: null,
  version: 1,
}));

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function mount(view: (client: ApiClient) => ReactNode, answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: String(input),
        body: String(init?.body ?? ''),
      };
      calls.push(call);
      const body = call.url.includes('/people')
        ? { people: PEOPLE, nextAfter: null }
        : answer(call);
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ status: 404 }), { status: 404 })
          : new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={queryClient}>{view(client)}</QueryClientProvider>);
  return calls;
}

describe('membership pickers by name', () => {
  it('policy simulation: picks the member by name, sends the id, shows no rule or code', async () => {
    const calls = mount(
      (client) => (
        <PolicySimulationScreen organizationSlug="acme" organizationName="Acme" client={client} />
      ),
      (call) =>
        call.method === 'POST' && call.url.includes('/policies/simulate')
          ? {
              result: {
                memberId: 'm-liam',
                role: 'member',
                capability: 'project.manage',
                allowed: false,
                decidingRule: 'role:member lacks project.manage',
                detail: 'Members cannot manage projects.',
                denialCode: 'CAPABILITY_MISSING',
                warnings: [],
              },
            }
          : call.url.includes('/projects')
            ? { projects: [] }
            : undefined,
    );
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Liam Osei' });
    await user.selectOptions(screen.getByRole('combobox', { name: /member/i }), 'Liam Osei');
    await user.click(screen.getByRole('button', { name: /simulate/i }));

    expect(await screen.findByText(/Members cannot manage projects/)).toBeInTheDocument();
    const post = calls.find((call) => call.method === 'POST');
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ memberId: 'm-liam' });
    expect(screen.queryByText(/role:member/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CAPABILITY_MISSING/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/member id/i)).not.toBeInTheDocument();
  });

  it('seats: lists each holder by name and assigns a seat by name', async () => {
    const calls = mount(
      (client) => (
        <BillingSeatsScreen organizationSlug="acme" organizationName="Acme" client={client} />
      ),
      (call) => {
        if (!call.url.includes('/billing/seats')) return undefined;
        if (call.method === 'POST') {
          return { id: 'seat-2', membershipId: 'm-liam', assignedAt: '2026-10-01T09:00:00.000Z' };
        }
        return {
          seats: [
            {
              id: 'seat-1',
              membershipId: 'm-ava',
              assignedAt: '2026-09-01T09:00:00.000Z',
              releasedAt: null,
            },
          ],
          activeCount: 1,
        };
      },
    );
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Ava Romero')).toBeInTheDocument();
    expect(within(table).queryByText('m-ava')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: /member/i }), 'Liam Osei');
    await user.click(screen.getByRole('button', { name: /assign/i }));
    await vi.waitFor(() =>
      expect(JSON.parse(calls.find((call) => call.method === 'POST')?.body ?? '{}')).toEqual({
        membershipId: 'm-liam',
      }),
    );
  });
});
