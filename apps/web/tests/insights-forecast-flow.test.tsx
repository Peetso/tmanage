import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsForecastScreen } from '../src/components/screens/InsightsForecastScreen';

// The app shell mounts MembershipGoneGate, which calls useRouter; jsdom has no Next app-router
// context, so the router is stubbed for the mount.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/**
 * BIL-05 — the workload forecast must not call every week "over capacity" when no capacity basis
 * exists (nobody carrying open work). A zero capacity is shown as "No capacity set" with a setup
 * prompt, never a false over-capacity alarm.
 */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <InsightsForecastScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const ZERO_CAPACITY = {
  weeks: [
    {
      weekIndex: 1,
      startsAt: '2026-08-17T00:00:00.000Z',
      committedItemCount: 1,
      capacity: 0,
      overCapacity: true,
    },
    {
      weekIndex: 2,
      startsAt: '2026-08-24T00:00:00.000Z',
      committedItemCount: 3,
      capacity: 0,
      overCapacity: true,
    },
  ],
  totals: {
    weeks: 2,
    memberCount: 0,
    committedItemCount: 4,
    capacity: 0,
    overCapacityWeekCount: 2,
  },
  computedAt: '2026-08-14T10:00:00.000Z',
};

describe('InsightsForecastScreen with no capacity basis', () => {
  it('shows a setup prompt and never flags a week over capacity', async () => {
    mount(ZERO_CAPACITY);

    expect(await screen.findByText(/Set a weekly capacity/i)).toBeTruthy();
    expect(screen.getAllByText('No capacity set').length).toBeGreaterThan(0);
    expect(screen.queryByText('Over capacity')).toBeNull();
    // Plurals read correctly: "1 item" in week 1, not "1 items".
    expect(screen.getByText('1 item')).toBeTruthy();
  });
});
