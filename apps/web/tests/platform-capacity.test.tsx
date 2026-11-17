import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { CapacityGaugeView, CapacityView } from '../src/lib/api/platform-capacity';
import { PlatformCapacityCard } from '../src/components/platform/health/PlatformCapacityCard';

/** 56-32 · the Server capacity card: each limit in words with its level, advice past Fine. */

afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const gauge = (over: Partial<CapacityGaugeView>): CapacityGaugeView => ({
  key: 'ram',
  value: 300,
  ceiling: 1024,
  percent: 29.3,
  colour: 'green',
  budgetPercent: 60,
  withinBudget: true,
  ...over,
});

const VIEW: CapacityView = {
  profile: {
    plan: null,
    ramMb: 1024,
    loopLagMs: 100,
    sockets: 500,
    inodes: 400_000,
    diskMb: 51_200,
    dbConnections: 25,
    measuredAt: null,
    source: 'planning',
  },
  latest: {
    sample: {
      takenAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      source: 'sample',
      rssMb: 300,
      heapMb: 120,
      loopLagMs: 12,
      sockets: 40,
      inodes: null,
      diskMb: null,
      dbMb: null,
      dbConnections: null,
    },
    nightly: null,
  },
  gauges: [
    gauge({}),
    gauge({ key: 'inodes', value: 300_000, ceiling: 400_000, percent: 75, colour: 'amber' }),
    gauge({ key: 'disk', value: 46_000, ceiling: 51_200, percent: 89.8, colour: 'red' }),
  ],
  trigger: { sentence: 'x', days: 7, due: false },
  redStreakDays: 0,
};

function mount(view: CapacityView) {
  const fetchImpl = ((input: RequestInfo | URL) => {
    const path = String(input).replace('https://api.example.test', '');
    if (path === '/v1/platform/health/capacity') return Promise.resolve(json(view));
    return Promise.resolve(json({ error: { code: 'not_found', message: 'x' } }, 404));
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PlatformCapacityCard api={client} />
    </QueryClientProvider>,
  );
}

describe('56-32 · Server capacity card', () => {
  it('says each level in words and gives advice only past Fine', async () => {
    mount(VIEW);
    expect(await screen.findByText('Fine')).toBeTruthy();
    expect(screen.getByText('Watch')).toBeTruthy();
    expect(screen.getByText('Act now')).toBeTruthy();
    expect(screen.queryByText(/Restart the app quietly/u)).toBeNull();
    expect(screen.getByText(/Remove old exports, previews and logs/u)).toBeTruthy();
    expect(screen.getByText(/Move old files to connected Drive/u)).toBeTruthy();
    expect(screen.getByText(/^Last measured/u)).toBeTruthy();
  });

  it('shows a calm empty state before the first reading', async () => {
    mount({ ...VIEW, gauges: [], latest: { sample: null, nightly: null } });
    expect(await screen.findByText(/No readings yet/u)).toBeTruthy();
  });
});
