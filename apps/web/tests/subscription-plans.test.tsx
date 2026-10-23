import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubscriptionScreen } from '../src/components/screens/SubscriptionScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * A12 — the in-app "Choose a plan" (Figma 376:17695 task 12, `fq12-plans`). The catalog, the
 * `pro` → `studio` read and the people count are proved beside the API; this file proves what the
 * screen draws and sends: five flat cards with Studio current, the info row, the yearly price, and
 * that "Switch to …" / "Upgrade" post the chosen plan.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const STUDIO = {
  planId: 'studio',
  status: 'active',
  currentPeriodEnd: null,
  internalPeopleCount: 8,
  nextBillAt: '2026-11-01T00:00:00.000Z',
  billingPeriod: 'monthly',
};

function mount() {
  const calls: Call[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (call.method === 'POST') {
        const { planId } = JSON.parse(call.body ?? '{}') as { planId: string };
        return Promise.resolve(json({ ...STUDIO, planId, status: 'pending_change' }));
      }
      return Promise.resolve(json(STUDIO));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <SubscriptionScreen
        organizationSlug="acme"
        organizationName="Northstar Studio"
        client={api}
      />
    </QueryClientProvider>,
  );
  return { calls };
}

function card(name: string): HTMLElement {
  return screen.getByRole('heading', { level: 2, name }).closest('li') as HTMLElement;
}

describe('Choose a plan', () => {
  it('draws five flat plans with Studio current and the info row', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 2, name: 'Studio' })).toBeTruthy();
    for (const name of ['Free', 'Starter', 'Business', 'Enterprise']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    const studio = card('Studio');
    expect(studio.getAttribute('aria-current')).toBe('true');
    expect(within(studio).getByText('Current plan')).toBeTruthy();
    expect(within(studio).getByText('$49')).toBeTruthy();
    expect(within(studio).getByRole('link', { name: 'Manage plan' })).toBeTruthy();
    expect(within(card('Free')).getByText('forever')).toBeTruthy();
    expect(within(card('Enterprise')).getByText('Custom')).toBeTruthy();
    expect(within(card('Enterprise')).getByRole('link', { name: 'Contact sales' })).toBeTruthy();
    expect(
      screen.getByText(
        'You have 8 internal people on Studio: $49 a month, flat. Next bill on 1 November. Yearly billing saves 20 %.',
      ),
    ).toBeTruthy();
  });

  it('shows the yearly price at 20 % off when Yearly is chosen', async () => {
    mount();
    await screen.findByRole('heading', { level: 2, name: 'Studio' });
    fireEvent.click(screen.getByRole('button', { name: 'Yearly · save 20%' }));
    expect(within(card('Studio')).getByText('$39.20')).toBeTruthy();
    expect(within(card('Starter')).getByText('a month, billed yearly')).toBeTruthy();
  });

  it('switches down with "Switch to Starter" and up with "Upgrade"', async () => {
    const { calls } = mount();
    await screen.findByRole('heading', { level: 2, name: 'Studio' });

    fireEvent.click(within(card('Starter')).getByRole('button', { name: 'Switch to Starter' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const first = calls.find((c) => c.method === 'POST');
    expect(first?.url).toContain('/v1/organizations/acme/billing/subscription/change');
    expect(JSON.parse(first?.body ?? '{}')).toEqual({ planId: 'starter' });

    // The returned view makes Starter current, so Business is still an upgrade.
    await waitFor(() => expect(card('Starter').getAttribute('aria-current')).toBe('true'));
    fireEvent.click(within(card('Business')).getByRole('button', { name: 'Upgrade' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(JSON.parse(calls.filter((c) => c.method === 'POST')[1]?.body ?? '{}')).toEqual({
      planId: 'business',
    });
  });
});
