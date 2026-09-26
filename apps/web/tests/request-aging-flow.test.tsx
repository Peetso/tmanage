import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { RequestAgingScreen } from '../src/components/screens/RequestAgingScreen';
import { expectNoAxeViolations } from './axe';

/**
 * x154 — the request-aging screen (module 11). The screen reads a single endpoint; the fake fetch
 * returns one body/status so the read can be given a success body or a refusal the way a caller
 * actually experiences it.
 */
type Reply = { body: unknown; status?: number };

function mount(reply: Reply) {
  const routed: typeof globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <RequestAgingScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const AGING = {
  thresholds: { agingDays: 3, overdueDays: 7 },
  counts: { fresh: 1, aging: 1, overdue: 1, uncommitted: 2, total: 3 },
  requests: [
    {
      id: 'request-1',
      title: 'Old overdue request',
      state: 'submitted',
      projectId: 'p1',
      clientOrganizationId: 'client-org-1',
      createdAt: '2026-09-10T10:00:00.000Z',
      ageDays: 10,
      bucket: 'overdue',
      committed: false,
    },
    {
      id: 'request-2',
      title: 'Aging request',
      state: 'triage',
      projectId: 'p1',
      clientOrganizationId: 'client-org-1',
      createdAt: '2026-09-16T10:00:00.000Z',
      ageDays: 4,
      bucket: 'aging',
      committed: true,
    },
    {
      id: 'request-3',
      title: 'Fresh request',
      state: 'submitted',
      projectId: 'p2',
      clientOrganizationId: 'client-org-1',
      createdAt: '2026-09-19T10:00:00.000Z',
      ageDays: 1,
      bucket: 'fresh',
      committed: false,
    },
  ],
  computedAt: '2026-09-20T10:00:00.000Z',
};

describe('RequestAgingScreen', () => {
  it('renders the aging buckets and the open requests as accessible tables', async () => {
    const { container } = mount({ body: AGING });

    const counts = (await screen.findByRole('table', {
      name: /open client requests by age/i,
    })) as HTMLTableElement;
    const countRows = within(counts);
    expect(countRows.getByRole('row', { name: /Overdue 1/i })).toBeTruthy();
    expect(countRows.getByRole('row', { name: /Total open 3/i })).toBeTruthy();

    // The oldest request is linked through to its triage detail.
    const link = await screen.findByRole('link', { name: /Old overdue request/i });
    expect(link.getAttribute('href')).toBe('/northstar/work/requests/request-1');

    await expectNoAxeViolations(container);
  });

  it('surfaces a client_request.triage refusal rather than rendering blank', async () => {
    mount({
      body: {
        error: {
          code: 'forbidden',
          message: 'You need client_request.triage.',
          correlationId: 'c',
        },
      },
      status: 403,
    });

    expect(await screen.findByText('You need client_request.triage.')).toBeTruthy();
  });
});
